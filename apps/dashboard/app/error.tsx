'use client';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  const busy = /SQLITE_BUSY|database is locked/i.test(error.message);
  return (
    <div className="empty" style={{ marginTop: 40 }}>
      <div style={{ fontSize: 16, marginBottom: 8 }}>
        {busy ? 'Database is being updated by the CLI…' : 'Something went wrong reading the database.'}
      </div>
      <div className="faint" style={{ fontSize: 12, marginBottom: 16 }}>
        {busy
          ? 'The readonly reader hit a write lock. This usually clears within a few seconds.'
          : error.message}
      </div>
      <button className="loadmore" onClick={reset} style={{ cursor: 'pointer', background: 'none' }}>
        Retry
      </button>
    </div>
  );
}
