import Link from 'next/link';
import { EmptyState } from '@/components/atoms';

export default function PositionNotFound() {
  return (
    <EmptyState hint={<Link href="/positions" className="dim">← back to positions</Link>}>
      Position not found.
    </EmptyState>
  );
}
