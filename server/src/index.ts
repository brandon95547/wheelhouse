import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DB_PATH, migrate } from './lib/db.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import contactsRouter from './routes/contacts.js';
import dashboardRouter from './routes/dashboard.js';
import ebayRouter from './routes/ebay.js';
import eventsRouter from './routes/events.js';
import leadsRouter from './routes/leads.js';
import metaRouter from './routes/meta.js';
import notesRouter from './routes/notes.js';
import projectsRouter from './routes/projects.js';
import referralPartnersRouter from './routes/referral-partners.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '127.0.0.1';

migrate();

const app = express();

/**
 * Wheelhouse runs locally, and the browser extension posts from a
 * chrome-extension:// origin, so CORS is open by default. Set
 * WHEELHOUSE_CORS_ORIGIN to lock it down if the server is ever exposed.
 */
app.use(cors({ origin: process.env.WHEELHOUSE_CORS_ORIGIN ?? true }));
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', database: DB_PATH });
});

app.use('/api/dashboard', dashboardRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/referral-partners', referralPartnersRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/notes', notesRouter);
app.use('/api/ebay', ebayRouter);
app.use('/api', metaRouter);

/**
 * If the client has been built, serve it from the same origin so `npm start`
 * gives a single URL. In development Vite serves the client instead.
 */
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, HOST, () => {
  console.log(`Wheelhouse API listening on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
