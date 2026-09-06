// js/data/sites.js — the four candidate landing sites, and the two hidden
// numbers per resource per site (DESIGN.md §8). Data with no logic in it, so
// what there is to test is that the data says what the design says it says:
// the numbers differ enough to be a decision, and the shape is total.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SITES, siteById, sitesOn } from '../js/data/sites.js';
import { missions } from '../js/data/missions.js';
import { lockReasons, isEligible } from '../js/core/contracts.js';
import { newGame, recordLaunch } from '../js/core/state.js';

test('every site has a unique id, a body, a name and both resources', () => {
  const ids = new Set();
  for (const site of SITES) {
    assert.ok(site.id && !ids.has(site.id), `duplicate or missing id: ${site.id}`);
    ids.add(site.id);
    assert.equal(typeof site.name, 'string');
    assert.equal(site.body, 'moon', 'phase 3b has one body with sites on it');
    assert.ok(site.resources.water.plentitude > 0, `${site.id} water plentitude`);
    assert.ok(site.resources.water.quality > 0, `${site.id} water quality`);
    assert.ok(site.resources.metals.plentitude > 0, `${site.id} metals plentitude`);
  }
});

// Metals are extracted and spent on-site; nothing processes them, so a
// `quality` on metals would be a number with nothing to multiply. The
// asymmetry is deliberate and js/core/base.js relies on it.
test('metals carry a plentitude and no quality', () => {
  for (const site of SITES) {
    assert.equal(site.resources.metals.quality, undefined, site.id);
  }
});

// The set has to span the interesting cases or the survey is a cutscene with
// a delta-v cost: something to land on for propellant, something to land on
// for growth, a safe middle, and a site that is simply bad.
test('the sites differ enough to be a decision', () => {
  const water = SITES.map((s) => s.resources.water.plentitude);
  const metals = SITES.map((s) => s.resources.metals.plentitude);
  assert.ok(Math.max(...water) / Math.min(...water) >= 2, 'water plentitude should span at least 2x');
  assert.ok(Math.max(...metals) / Math.min(...metals) >= 2, 'metals plentitude should span at least 2x');

  // At least one site trades the two AGAINST each other, which is what makes
  // the choice a choice rather than a ranking.
  const traded = SITES.some((s) => (
    (s.resources.water.plentitude > 1 && s.resources.metals.plentitude < 1)
    || (s.resources.water.plentitude < 1 && s.resources.metals.plentitude > 1)
  ));
  assert.ok(traded, 'no site trades water against metals; the set is a ranking, not a decision');
});

test('exactly one site is dominated in both resources — the bad news a survey can bring', () => {
  const bad = SITES.filter((s) => SITES.some((o) => o !== s
    && o.resources.water.plentitude > s.resources.water.plentitude
    && o.resources.water.quality > s.resources.water.quality
    && o.resources.metals.plentitude > s.resources.metals.plentitude));
  assert.equal(bad.length, 1, `expected one clearly bad site, got [${bad.map((s) => s.id)}]`);
});

test('siteById and sitesOn', () => {
  assert.equal(siteById('mare-tranquil').name, 'Mare Tranquillitatis');
  assert.equal(siteById('nowhere'), null);
  assert.deepEqual(sitesOn('moon').map((s) => s.id), SITES.map((s) => s.id));
  assert.deepEqual(sitesOn('mars'), []);
});

// ---------------------------------------------------------------------------
// The survey: the contract that reveals a site, and the gate that closes once
// it has.
// ---------------------------------------------------------------------------

const surveyFor = (siteId) => missions.find((m) => m.requirement.moon?.site === siteId);

/** A state that clears every gate a survey contract has except the site one. */
function readyState() {
  const s = newGame(1);
  const survey = surveyFor('mare-tranquil');
  return {
    ...s, tier: 4, reputation: 100, owned: [...survey.requiresNode],
  };
}

test('a survey contract is offerable while its site is unsurveyed', () => {
  const state = readyState();
  const m = surveyFor('mare-tranquil');
  assert.deepEqual(lockReasons(state, m), []);
  assert.equal(isEligible(state, m), true);
});

test('a survey contract closes once its site has been surveyed', () => {
  const state = { ...readyState(), sites: { 'mare-tranquil': { surveyed: true } } };
  const m = surveyFor('mare-tranquil');
  assert.deepEqual(lockReasons(state, m), [{ kind: 'surveyed', site: 'mare-tranquil' }]);
  assert.equal(isEligible(state, m), false);
  // ...and only that one. Surveying one site must not close the others, or
  // the first survey would end the whole activity.
  assert.equal(isEligible(state, surveyFor('shackleton-rim')), true);
});

test('a successful survey marks the site surveyed', () => {
  const state = readyState();
  const m = surveyFor('shackleton-rim');
  const outcome = {
    success: true, maxAltitude: 180000, readout: 'Survey complete: the site is mapped.',
    lunar: { reached: 1, profile: 'survey' },
  };
  const next = recordLaunch(state, m, outcome);
  assert.deepEqual(next.sites, { 'shackleton-rim': { surveyed: true } });
  assert.equal(next.history.at(-1).surveyed, 'shackleton-rim');
  assert.deepEqual(state.sites, {}, 'the input state is not mutated');
});

test('a FAILED survey reveals nothing', () => {
  const state = readyState();
  const m = surveyFor('shackleton-rim');
  const outcome = {
    success: false, maxAltitude: 90000, readout: 'Short by 400 m/s for the lunar orbit insertion burn.',
    lunar: { reached: 0, profile: 'survey' },
  };
  const next = recordLaunch(state, m, outcome);
  assert.deepEqual(next.sites, {});
  assert.equal(next.history.at(-1).surveyed, null);
});

test('a non-survey flight never marks a site, however successful', () => {
  const state = readyState();
  const land = missions.find((m) => m.id === 'moon-land');
  const outcome = {
    success: true, maxAltitude: 180000, readout: 'Landed on the moon.',
    lunar: { reached: 2, profile: 'land', landed: true },
  };
  const next = recordLaunch(state, land, outcome);
  assert.deepEqual(next.sites, {});
  assert.equal(next.history.at(-1).surveyed, null);
});

test('re-surveying a known site is a no-op rather than a rewrite', () => {
  const state = { ...readyState(), sites: { 'far-side-flats': { surveyed: true } } };
  const m = surveyFor('far-side-flats');
  const outcome = { success: true, maxAltitude: 1, readout: 'ok', lunar: { reached: 1, profile: 'survey' } };
  const next = recordLaunch(state, m, outcome);
  assert.deepEqual(next.sites, { 'far-side-flats': { surveyed: true } });
});
