import type { ReactNode } from 'react';
import { useOutletContext } from 'react-router-dom';
import { PageHeader } from './ui';

/** Renders the description the layout supplies for the current route. */
export function PageIntro({ actions }: { actions?: ReactNode }) {
  const { description } = useOutletContext<{ description: string }>();
  return <PageHeader description={description} actions={actions} />;
}
