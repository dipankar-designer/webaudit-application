import { Compass } from 'lucide-react';
import { Card, EmptyState, LinkButton } from '../components/ui';

export function NotFoundPage() {
  return (
    <Card>
      <EmptyState icon={<Compass className="size-6" aria-hidden />} title="Page not found" action={<LinkButton to="/dashboard">Go to overview</LinkButton>}>
        The page you were looking for does not exist or you do not have access to it.
      </EmptyState>
    </Card>
  );
}
