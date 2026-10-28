# Deployment runbook

The application runs as a single Node process behind nginx. The database is one
file at /opt/ai-brain/data/brain.db.

To deploy: pull, pnpm install, pnpm build, systemctl restart ai-brain.
Backups run nightly and copy the database file to object storage.
