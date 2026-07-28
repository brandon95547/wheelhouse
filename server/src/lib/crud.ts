import { Router } from 'express';
import type { Request } from 'express';
import { db } from './db.js';
import { notFound } from './errors.js';
import { parseId, validateCreate, validatePatch, type Schema } from './validate.js';

export const nowIso = (): string => new Date().toISOString();

export interface ResourceConfig {
  /** Table name. Interpolated into SQL, so this must never come from input. */
  table: string;
  schema: Schema;
  /** Columns matched against the `search` query parameter. */
  searchColumns: string[];
  /** Maps a query parameter name to the column it filters on. */
  filters?: Record<string, string>;
  /** Additional WHERE clauses, e.g. date ranges, built from the query string. */
  extraWhere?: (req: Request) => { sql: string; params: unknown[] } | null;
  /**
   * Full `SELECT ... FROM <table> t` clause, letting a resource join in extra
   * display columns. Defaults to selecting every column of the table.
   */
  selectSql?: string;
  orderBy?: string;
  /** Extra work inside the create/update transaction, e.g. cascade updates. */
  afterWrite?: (id: number) => void;
}

/**
 * Builds a standard list / create / update / delete router for one table.
 * Resources with extra endpoints mount this and then add their own routes.
 */
export function createResourceRouter(config: ResourceConfig): Router {
  const {
    table,
    schema,
    searchColumns,
    filters = {},
    selectSql = `SELECT t.* FROM ${config.table} t`,
    orderBy = 't.created_at DESC, t.id DESC',
  } = config;

  const router = Router();

  const buildWhere = (req: Request) => {
    const clauses: string[] = [];
    const params: unknown[] = [];

    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (search && searchColumns.length) {
      const like = `%${search.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      clauses.push(
        `(${searchColumns
          .map((col) => `${col} LIKE ? ESCAPE '\\'`)
          .join(' OR ')})`,
      );
      params.push(...searchColumns.map(() => like));
    }

    for (const [param, column] of Object.entries(filters)) {
      const raw = req.query[param];
      if (typeof raw !== 'string' || raw === '' || raw === 'all') continue;
      if (raw === 'none') {
        clauses.push(`${column} IS NULL`);
      } else {
        clauses.push(`${column} = ?`);
        params.push(raw);
      }
    }

    const extra = config.extraWhere?.(req);
    if (extra) {
      clauses.push(extra.sql);
      params.push(...extra.params);
    }

    return {
      sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  };

  const findById = (id: number): Record<string, unknown> | undefined =>
    db.prepare(`${selectSql} WHERE t.id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;

  router.get('/', (req, res) => {
    const where = buildWhere(req);
    const rows = db
      .prepare(`${selectSql}${where.sql} ORDER BY ${orderBy}`)
      .all(...where.params);
    res.json(rows);
  });

  router.get('/:id', (req, res) => {
    const row = findById(parseId(req.params.id));
    if (!row) throw notFound(`No ${table} record with that id`);
    res.json(row);
  });

  router.post('/', (req, res) => {
    const values = validateCreate(req.body, schema);
    const columns = Object.keys(values);
    const timestamp = nowIso();

    const info = db
      .prepare(
        `INSERT INTO ${table} (${columns.join(', ')}, created_at, updated_at)
         VALUES (${columns.map(() => '?').join(', ')}, ?, ?)`,
      )
      .run(...columns.map((c) => values[c] as never), timestamp, timestamp);

    const id = Number(info.lastInsertRowid);
    config.afterWrite?.(id);
    res.status(201).json(findById(id));
  });

  router.patch('/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!findById(id)) throw notFound(`No ${table} record with that id`);

    const values = validatePatch(req.body, schema);
    const columns = Object.keys(values);

    db.prepare(
      `UPDATE ${table}
          SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
        WHERE id = ?`,
    ).run(...columns.map((c) => values[c] as never), nowIso(), id);

    config.afterWrite?.(id);
    res.json(findById(id));
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    if (!info.changes) throw notFound(`No ${table} record with that id`);
    res.json({ deleted: id });
  });

  return router;
}
