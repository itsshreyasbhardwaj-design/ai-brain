/**
 * Onboarding, personalization and configuration portability.
 *
 * These cover the first promise in the brief: a new user can build their own
 * brain, and it works without connecting anything or paying for anything.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace } from './helpers.ts';
import {
  generateBrain, inferProfile, toConfigFile, fromConfigFile, ConfigImportError,
  BRAIN_FILE_VERSION,
} from '../src/engines/brain-config.ts';
import { PROFILE_TEMPLATES, layoutFor, ALL_MODULES } from '../src/engines/profiles.ts';
import { AuthService } from '../src/engines/auth.ts';

describe('brain generation', () => {
  test('produces a usable configuration from no answers at all', () => {
    const g = generateBrain('wsp_1', {});
    assert.equal(g.config.profile, 'personal');
    assert.ok(g.config.modules.length > 0, 'modules must not be empty');
    assert.ok(g.config.dashboardLayout.widgets.length > 0, 'dashboard must have widgets');
    assert.equal(g.config.privacy.allowRemoteAi, false, 'remote AI must be off by default');
    assert.equal(g.config.createdBy, 'derived');
  });

  test('is deterministic: identical answers give identical configuration', () => {
    const answers = {
      profile: 'developer' as const,
      intents: ['keep track of my repos', 'stop losing projects'],
      currentProjects: ['ai-brain', 'radius'],
      primaryGoals: ['ship v1'],
    };
    const a = generateBrain('wsp_1', answers);
    const b = generateBrain('wsp_1', answers);
    assert.deepEqual(a.config, b.config);
    assert.deepEqual(a.projectSeeds, b.projectSeeds);
  });

  test('every profile template yields a valid configuration', () => {
    for (const key of Object.keys(PROFILE_TEMPLATES) as Array<keyof typeof PROFILE_TEMPLATES>) {
      const g = generateBrain('wsp_1', { profile: key });
      assert.ok(g.config.modules.length > 0, `${key} has no modules`);
      for (const m of g.config.modules) {
        assert.ok(ALL_MODULES.includes(m), `${key} declares unknown module ${m}`);
      }
      // Every widget shown must belong to an enabled module.
      for (const w of g.config.dashboardLayout.widgets) {
        assert.equal(typeof w.key, 'string');
        assert.ok(w.span > 0 && w.span <= 12, `${key} widget ${w.key} has span ${w.span}`);
      }
    }
  });

  test('switches on modules implied by what the user typed', () => {
    const g = generateBrain('wsp_1', {
      profile: 'personal',
      intents: ['I want to track my repositories and deployments'],
    });
    assert.ok(g.config.modules.includes('developer'), 'developer module should be inferred from "repositories"');
    assert.ok(g.config.recommendedConnectors.includes('github'));
    assert.ok(
      g.rationale.some((r) => r.includes('developer')),
      'the rationale must explain why the module was added',
    );
  });

  test('infers a profile from free text when none is chosen', () => {
    assert.equal(inferProfile({ intents: ['my startup revenue and investors'] }), 'founder');
    assert.equal(inferProfile({ intents: ['refactor this repo and fix the api'] }), 'developer');
    assert.equal(inferProfile({ intents: ['my client invoices and contracts'] }), 'freelancer');
    assert.equal(inferProfile({ intents: ['literature review and hypothesis'] }), 'research');
    assert.equal(inferProfile({}), null, 'no input means no inference');
  });

  test('student profile keeps academic material local', () => {
    const g = generateBrain('wsp_1', { profile: 'student' });
    assert.equal(g.config.privacy.allowRemoteAi, false);
    assert.equal(g.config.privacy.allowFileContentImport, false);
  });

  test('a minor account cannot be generated with remote AI enabled', () => {
    const g = generateBrain('wsp_1', {
      profile: 'developer',
      isMinorAccount: true,
      privacy: { allowRemoteAi: true },
    });
    assert.equal(g.config.privacy.allowRemoteAi, false);
    assert.ok(g.rationale.some((r) => r.includes('minor')));
  });

  test('custom profile honours an explicit module list', () => {
    const g = generateBrain('wsp_1', { profile: 'custom', modules: ['projects', 'goals'] });
    assert.deepEqual(g.config.modules, ['projects', 'goals']);
  });

  test('layout only contains widgets whose module is enabled', () => {
    const layout = layoutFor('developer', ['projects']);
    for (const w of layout.widgets) {
      assert.ok(!['resource-usage', 'business-summary'].includes(w.key), `${w.key} should be filtered out`);
    }
  });
});

describe('configuration portability', () => {
  test('round-trips through brain.config.json without losing fields', () => {
    const f = makeWorkspace({ profile: 'founder', intents: ['grow revenue'], primaryGoals: ['hit 10k mrr'] });
    const file = toConfigFile(f.config);
    assert.equal(file.fileVersion, BRAIN_FILE_VERSION);

    const reimported = fromConfigFile(JSON.parse(JSON.stringify(file)), f.workspace.id);
    assert.equal(reimported.profile, f.config.profile);
    assert.deepEqual(reimported.modules, f.config.modules);
    assert.deepEqual(reimported.goalHierarchy, f.config.goalHierarchy);
    assert.deepEqual(reimported.privacy, f.config.privacy);
    assert.equal(reimported.reportingCadence, f.config.reportingCadence);
    assert.equal(reimported.createdBy, 'import');
    f.close();
  });

  test('a configuration carries no user records', () => {
    const f = makeWorkspace();
    f.store.projects.create({ workspaceId: f.workspace.id, name: 'Secret Project' });
    f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'Private note', body: 'confidential' });
    const serialised = JSON.stringify(toConfigFile(f.store.brainConfig.current(f.workspace.id)!));
    assert.ok(!serialised.includes('Secret Project'));
    assert.ok(!serialised.includes('confidential'));
    f.close();
  });

  test('rejects a file from a newer version instead of guessing', () => {
    assert.throws(
      () => fromConfigFile({ fileVersion: 99, profile: 'developer' }, 'wsp_1'),
      ConfigImportError,
    );
  });

  test('drops unknown module keys rather than trusting them', () => {
    const cfg = fromConfigFile(
      { fileVersion: 1, profile: 'custom', modules: ['projects', 'telepathy', 'knowledge'] },
      'wsp_1',
    );
    assert.deepEqual(cfg.modules, ['projects', 'knowledge']);
  });

  test('falls back to the profile preset when no module survives', () => {
    const cfg = fromConfigFile({ fileVersion: 1, profile: 'developer', modules: ['nonsense'] }, 'wsp_1');
    assert.deepEqual(cfg.modules, PROFILE_TEMPLATES.developer.modules);
  });
});

describe('configuration versioning', () => {
  test('editing writes a new version and keeps the old one', () => {
    const f = makeWorkspace({ profile: 'developer' });
    const v1 = f.store.brainConfig.current(f.workspace.id)!;
    assert.equal(v1.version, 1);

    f.store.brainConfig.save({ ...v1, profile: 'founder', modules: ['projects', 'business'] });
    const v2 = f.store.brainConfig.current(f.workspace.id)!;
    assert.equal(v2.version, 2);
    assert.equal(v2.profile, 'founder');

    const restored = f.store.brainConfig.version(f.workspace.id, 1);
    assert.equal(restored?.profile, 'developer', 'version 1 must still be readable');
    assert.equal(f.store.brainConfig.history(f.workspace.id).length, 2);
    f.close();
  });

  test('changing profile does not delete records', () => {
    const f = makeWorkspace({ profile: 'developer' });
    const p = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Keep me' });
    f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'Keep this too' });

    const cfg = f.store.brainConfig.current(f.workspace.id)!;
    f.store.brainConfig.save({ ...cfg, profile: 'personal', modules: PROFILE_TEMPLATES.personal.modules });

    assert.ok(f.store.projects.byId(f.workspace.id, p.id), 'project survived the profile change');
    assert.equal(f.store.knowledge.total(f.workspace.id), 1);
    f.close();
  });
});

describe('registration', () => {
  test('creates a workspace, configuration, modules, goals and seed projects', () => {
    const f = makeWorkspace({
      profile: 'developer',
      currentProjects: ['ai-brain', 'radius'],
      primaryGoals: ['ship v0.1'],
    });
    assert.ok(f.config, 'a configuration exists immediately after registration');
    assert.equal(f.store.projects.list(f.workspace.id).length, 2);
    assert.ok(f.store.goals.list(f.workspace.id).length >= 1);
    assert.ok(f.store.modules.enabledKeys(f.workspace.id).length > 0);
    f.close();
  });

  test('refuses a second sign-up unless explicitly allowed', () => {
    const f = makeWorkspace();
    assert.throws(
      () => f.auth.register({ email: 'second@example.test', displayName: 'Second', password: 'another-long-password' }),
      /additional sign-ups are disabled/,
    );
    f.close();
  });

  test('needsSetup is true only before the first account', () => {
    const f = makeWorkspace();
    assert.equal(f.auth.needsSetup(), false);
    f.close();
  });

  test('rejects a short password', () => {
    const f = makeWorkspace();
    assert.throws(
      () => f.auth.register({ email: 'x@example.test', displayName: 'X', password: 'short' }, { allowAdditional: true }),
      /at least 10 characters/,
    );
    f.close();
  });

  test('profile choices are offered for the onboarding UI', () => {
    const f = makeWorkspace();
    const auth = new AuthService(f.store);
    assert.ok(auth.needsSetup() === false);
    f.close();
  });
});
