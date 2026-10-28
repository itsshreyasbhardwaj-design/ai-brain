/**
 * The knowledge engine: import, classification, search, duplicate and
 * contradiction detection, and the guarantee that generated text is never
 * confused with verified information.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, daysAgo } from './helpers.ts';
import {
  KnowledgeEngine, classify, parseMarkdown, parseConversationExport,
  polarityOf, subjectOf,
} from '../src/engines/knowledge.ts';

const OPEN: { allowFileContentImport: boolean; excludedCategories: string[] } = {
  allowFileContentImport: true,
  excludedCategories: [],
};

describe('classification', () => {
  test('recognises the five knowledge classes from real phrasing', () => {
    assert.equal(classify('Decision: use SQLite', 'We chose SQLite because Node ships it.'), 'decision');
    assert.equal(classify('Next steps', '- [ ] write the migration\n- [ ] run the tests'), 'action');
    assert.equal(classify('Idea: offline mode', 'What if the app worked with no network at all?'), 'idea');
    assert.equal(classify('Why the build was slow', 'Turns out the root cause was a missing cache key. Lesson learned.'), 'insight');
    assert.equal(classify('Database location', 'The database is at ./data/brain.db and runs on SQLite.'), 'fact');
  });

  test('defaults to fact rather than guessing', () => {
    assert.equal(classify('Untitled', 'qwerty asdf'), 'fact');
  });

  test('is deterministic', () => {
    const a = classify('Decision: ship it', 'We decided to ship.');
    const b = classify('Decision: ship it', 'We decided to ship.');
    assert.equal(a, b);
  });
});

describe('markdown parsing', () => {
  test('reads YAML front matter, inline list tags and the first heading', () => {
    const md = [
      '---',
      'title: Architecture notes',
      'tags: [architecture, storage]',
      '---',
      '',
      '# Ignored because front matter wins',
      '',
      'We use SQLite. See also #decisions',
    ].join('\n');
    const parsed = parseMarkdown('notes.md', md);
    assert.equal(parsed.title, 'Architecture notes');
    assert.ok(parsed.tags.includes('architecture'));
    assert.ok(parsed.tags.includes('storage'));
    assert.ok(parsed.tags.includes('decisions'), 'inline hashtags are picked up');
    assert.ok(!parsed.body.includes('---'));
  });

  test('reads dashed YAML lists', () => {
    const md = ['---', 'tags:', '  - alpha', '  - beta', '---', '# Title here', 'Body.'].join('\n');
    const parsed = parseMarkdown('x.md', md);
    assert.deepEqual(parsed.tags.sort(), ['alpha', 'beta']);
    assert.equal(parsed.title, 'Title here');
  });

  test('falls back to the heading, then the filename', () => {
    assert.equal(parseMarkdown('f.md', '## Real heading\n\nbody').title, 'Real heading');
    assert.equal(parseMarkdown('my-notes-file.md', 'no heading at all').title, 'my notes file');
  });
});

describe('ingest', () => {
  test('stores a document with provenance and derived classification', () => {
    const f = makeWorkspace();
    const e = new KnowledgeEngine(f.store);
    const r = e.ingest(f.workspace.id, {
      title: 'Decision: use SQLite',
      body: 'We chose SQLite because Node ships it.',
      locator: '/notes/adr-001.md',
    }, OPEN);

    assert.equal(r.status, 'created');
    assert.equal(r.record?.klass, 'decision');
    assert.equal(r.record?.origin, 'import');
    assert.equal(r.record?.confidence, 'high', 'imported text is not an observation this system made');
    assert.ok(r.record?.tags.includes('auto-classified'), 'derived classification is labelled');
    f.close();
  });

  test('importing the same file twice does not duplicate it', () => {
    const f = makeWorkspace();
    const e = new KnowledgeEngine(f.store);
    const doc = { title: 'Same note', body: 'Identical content.', locator: '/a.md' };
    const first = e.ingest(f.workspace.id, doc, OPEN);
    const second = e.ingest(f.workspace.id, doc, OPEN);
    assert.equal(first.status, 'created');
    assert.equal(second.status, 'duplicate');
    assert.equal(second.record?.id, first.record?.id);
    assert.equal(f.store.knowledge.total(f.workspace.id), 1);
    f.close();
  });

  test('redacts secrets before anything is stored', () => {
    const f = makeWorkspace();
    const e = new KnowledgeEngine(f.store);
    const r = e.ingest(f.workspace.id, {
      title: 'Deploy notes',
      body: 'Use AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY and token ghp_abcdefghijklmnopqrstuvwxyz0123456789.',
      locator: '/deploy.md',
    }, OPEN);

    assert.ok(r.redactions >= 2, `expected redactions, got ${r.redactions}`);
    assert.ok(!r.record!.body.includes('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'));
    assert.ok(!r.record!.body.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
    assert.ok(r.record!.body.includes('[redacted:'));

    // And the stored row, not just the returned object.
    const stored = f.store.knowledge.byId(f.workspace.id, r.record!.id)!;
    assert.ok(!stored.body.includes('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'));
    f.close();
  });

  test('honours the no-file-content privacy setting', () => {
    const f = makeWorkspace();
    const e = new KnowledgeEngine(f.store);
    const r = e.ingest(f.workspace.id, {
      title: 'Private essay', body: 'Something the user does not want stored.', locator: '/p.md',
    }, { allowFileContentImport: false, excludedCategories: [] });

    assert.equal(r.status, 'created');
    assert.ok(!r.record!.body.includes('does not want stored'));
    assert.ok(r.record!.body.includes('not imported'));
    f.close();
  });

  test('skips documents in an excluded category', () => {
    const f = makeWorkspace();
    const e = new KnowledgeEngine(f.store);
    const r = e.ingest(f.workspace.id, {
      title: 'Medical results', body: 'Private.', locator: '/m.md', tags: ['health'],
    }, { allowFileContentImport: true, excludedCategories: ['health'] });

    assert.equal(r.status, 'skipped-empty');
    assert.equal(r.record, null);
    assert.equal(f.store.knowledge.total(f.workspace.id), 0);
    f.close();
  });

  test('a batch import is tracked and counted', () => {
    const f = makeWorkspace();
    const e = new KnowledgeEngine(f.store);
    const result = e.ingestBatch(f.workspace.id, 'markdown', '12 notes', [
      { title: 'One', body: 'First note.', locator: '/1.md' },
      { title: 'Two', body: 'Second note.', locator: '/2.md' },
      { title: 'One', body: 'First note.', locator: '/1-copy.md' },
    ], OPEN);

    assert.equal(result.created, 2);
    assert.equal(result.skipped, 1);
    const batches = f.store.imports.list(f.workspace.id);
    assert.equal(batches[0]!.status, 'success');
    assert.equal(batches[0]!.recordsCreated, 2);
    assert.equal(batches[0]!.fileCount, 3);
    f.close();
  });
});

describe('search', () => {
  test('full-text search finds records by body term', () => {
    const f = makeWorkspace();
    const e = new KnowledgeEngine(f.store);
    e.ingest(f.workspace.id, { title: 'Storage choice', body: 'SQLite ships inside Node, so there is no server.', locator: '/a.md' }, OPEN);
    e.ingest(f.workspace.id, { title: 'Deployment', body: 'Docker compose is optional for self-hosting.', locator: '/b.md' }, OPEN);

    const hits = f.store.knowledge.search(f.workspace.id, 'sqlite');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.record.title, 'Storage choice');
    assert.ok(hits[0]!.snippet.length > 0, 'a snippet is returned');
    f.close();
  });

  test('matches on a word stem', () => {
    const f = makeWorkspace();
    const e = new KnowledgeEngine(f.store);
    e.ingest(f.workspace.id, { title: 'Deploying', body: 'We deployed the service on Friday.', locator: '/a.md' }, OPEN);
    assert.ok(f.store.knowledge.search(f.workspace.id, 'deploy').length > 0);
    f.close();
  });

  test('filters by class, project and tag', () => {
    const f = makeWorkspace();
    const p = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Scoped' });
    f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'A decision', klass: 'decision', projectId: p.id, tags: ['arch'], body: 'alpha' });
    f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'An idea', klass: 'idea', body: 'alpha' });

    assert.equal(f.store.knowledge.search(f.workspace.id, 'alpha', { klass: ['decision'] }).length, 1);
    assert.equal(f.store.knowledge.search(f.workspace.id, 'alpha', { projectId: p.id }).length, 1);
    assert.equal(f.store.knowledge.search(f.workspace.id, 'alpha', { tags: ['arch'] }).length, 1);
    assert.equal(f.store.knowledge.search(f.workspace.id, 'alpha').length, 2);
    f.close();
  });

  test('a malformed query degrades instead of throwing', () => {
    const f = makeWorkspace();
    f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'Quoted', body: 'has "quotes" and (parens)' });
    for (const q of ['"', '((', 'AND', 'NEAR(', '*', '']) {
      assert.doesNotThrow(() => f.store.knowledge.search(f.workspace.id, q), `query ${JSON.stringify(q)} threw`);
    }
    f.close();
  });

  test('an updated record is reindexed', () => {
    const f = makeWorkspace();
    const k = f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'Original', body: 'mentions postgres' });
    assert.equal(f.store.knowledge.search(f.workspace.id, 'postgres').length, 1);

    f.store.knowledge.update(f.workspace.id, k.id, { body: 'now mentions mariadb' });
    assert.equal(f.store.knowledge.search(f.workspace.id, 'postgres').length, 0, 'stale index entry must be gone');
    assert.equal(f.store.knowledge.search(f.workspace.id, 'mariadb').length, 1);
    f.close();
  });

  test('a deleted record leaves no index entry', () => {
    const f = makeWorkspace();
    const k = f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'Temporary', body: 'ephemeral content' });
    f.store.knowledge.delete(f.workspace.id, k.id);
    assert.equal(f.store.knowledge.search(f.workspace.id, 'ephemeral').length, 0);
    f.close();
  });
});

describe('contradiction detection', () => {
  test('flags a direct reversal of an earlier fact', () => {
    const f = makeWorkspace();
    const e = new KnowledgeEngine(f.store);
    e.ingest(f.workspace.id, { title: 'We use Postgres', body: 'Postgres is the primary database.', locator: '/1.md', klass: 'fact' }, OPEN);
    const second = e.ingest(f.workspace.id, { title: 'We no longer use Postgres', body: 'Postgres was removed.', locator: '/2.md', klass: 'fact' }, OPEN);

    assert.ok(second.contradicts, 'the reversal should be detected');
    assert.equal(second.record?.contradictsId, second.contradicts?.id);
    assert.equal(e.contradictions(f.workspace.id).length, 1);
    f.close();
  });

  test('does not invent contradictions between unrelated records', () => {
    const f = makeWorkspace();
    const e = new KnowledgeEngine(f.store);
    e.ingest(f.workspace.id, { title: 'We use Postgres', body: 'Primary database.', locator: '/1.md', klass: 'fact' }, OPEN);
    const other = e.ingest(f.workspace.id, { title: 'We use Tailwind', body: 'For styling.', locator: '/2.md', klass: 'fact' }, OPEN);
    assert.equal(other.contradicts, null);
    f.close();
  });

  test('ideas and actions are not checked for contradiction', () => {
    const f = makeWorkspace();
    const e = new KnowledgeEngine(f.store);
    e.ingest(f.workspace.id, { title: 'Use Redis', body: 'We use Redis.', locator: '/1.md', klass: 'idea' }, OPEN);
    const r = e.ingest(f.workspace.id, { title: 'Use Redis', body: 'We no longer use Redis.', locator: '/2.md', klass: 'idea' }, OPEN);
    assert.equal(r.contradicts, null);
    f.close();
  });

  test('superseding archives the old record but keeps it readable', () => {
    const f = makeWorkspace();
    const e = new KnowledgeEngine(f.store);
    const old = e.ingest(f.workspace.id, { title: 'Port is 3000', body: 'The dev server runs on 3000.', locator: '/1.md' }, OPEN).record!;
    const next = e.ingest(f.workspace.id, { title: 'Port is 4000', body: 'The dev server now runs on 4000.', locator: '/2.md' }, OPEN).record!;

    e.supersede(f.workspace.id, old.id, next.id);
    assert.equal(f.store.knowledge.byId(f.workspace.id, next.id)?.supersedesId, old.id);
    assert.ok(f.store.knowledge.byId(f.workspace.id, old.id)?.archivedAt, 'old record is archived');
    assert.equal(f.store.knowledge.total(f.workspace.id), 1, 'archived records are out of the active count');
    assert.ok(f.store.knowledge.byId(f.workspace.id, old.id), 'but still retrievable by id');
    f.close();
  });

  test('polarity and subject extraction behave as the detector expects', () => {
    assert.equal(polarityOf('we use postgres'), 1);
    assert.equal(polarityOf('we no longer use postgres'), -1);
    assert.equal(polarityOf('postgres'), 0);
    assert.equal(subjectOf('We use Postgres'), subjectOf('We no longer use Postgres'));
  });
});

describe('knowledge statistics and freshness', () => {
  test('reports stale records honestly', () => {
    const f = makeWorkspace();
    f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'Ancient', body: 'old', observedAt: daysAgo(400) });
    f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'Fresh', body: 'new' });

    const e = new KnowledgeEngine(f.store);
    assert.equal(e.staleRecords(f.workspace.id).length, 1);
    const stats = e.stats(f.workspace.id);
    assert.equal(stats.total, 2);
    assert.equal(stats.stale, 1);
    f.close();
  });

  test('generated records are counted separately from observed ones', () => {
    const f = makeWorkspace();
    f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'Model summary', body: 'written by a model', origin: 'generated', confidence: 'low' });
    f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'My note', body: 'typed by me', origin: 'manual' });

    const stats = new KnowledgeEngine(f.store).stats(f.workspace.id);
    assert.equal(stats.generated, 1);
    assert.equal(stats.total, 2);
    f.close();
  });

  test('related records are found without a model', () => {
    const f = makeWorkspace();
    const p = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Linked' });
    const a = f.store.knowledge.create({ workspaceId: f.workspace.id, projectId: p.id, title: 'Migration strategy', body: 'incremental migration of the database schema' });
    f.store.knowledge.create({ workspaceId: f.workspace.id, projectId: p.id, title: 'Schema notes', body: 'the database schema has twenty tables' });

    const related = new KnowledgeEngine(f.store).related(f.workspace.id, a.id);
    assert.ok(related.length >= 1);
    assert.ok(!related.some((r) => r.id === a.id), 'a record is not related to itself');
    f.close();
  });
});

describe('conversation export import', () => {
  test('parses an export into documents', () => {
    const raw = JSON.stringify([
      {
        title: 'Designing the schema',
        create_time: 1760000000,
        messages: [
          { role: 'user', content: 'How should I store projects?' },
          { role: 'assistant', content: [{ type: 'text', text: 'One table with a source key.' }] },
        ],
      },
      { title: 'Empty one', messages: [] },
    ]);
    const docs = parseConversationExport(raw);
    assert.equal(docs.length, 1, 'conversations with no messages are skipped');
    assert.equal(docs[0]!.title, 'Designing the schema');
    assert.ok(docs[0]!.body.includes('source key'));
    assert.ok(docs[0]!.tags?.includes('conversation'));
  });

  test('returns nothing for unrecognised input instead of inventing structure', () => {
    assert.deepEqual(parseConversationExport('not json'), []);
    assert.deepEqual(parseConversationExport('{"unexpected":true}'), []);
  });
});
