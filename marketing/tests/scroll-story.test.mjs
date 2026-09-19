import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { progressFor, sceneAt } from '../public/scroll-story.js';

describe('scroll composition math', () => {
  it('clamps before/after the narrative and tolerates short content', () => {
    assert.equal(progressFor(200, 4000, 1000), 0);
    assert.equal(progressFor(-1500, 4000, 1000), .5);
    assert.equal(progressFor(-4000, 4000, 1000), 1);
    assert.equal(progressFor(-100, 500, 1000), 0);
  });
  it('has four finite poses and a fully composed endpoint', () => {
    for (const progress of [-1, 0, 1/3, .5, 2/3, 1, 2]) {
      const scene = sceneAt(progress);
      assert.equal(scene.layers.length, 4);
      assert.ok(scene.layers.flat().every(Number.isFinite));
      assert.ok(scene.chapter >= 0 && scene.chapter <= 3);
      assert.ok(scene.core >= 0 && scene.core <= 1);
    }
    assert.equal(sceneAt(0).core, 0);
    assert.equal(sceneAt(1).core, 1);
  });
  it('is reversible and continuous through chapter boundaries', () => {
    assert.deepEqual(sceneAt(.2), sceneAt(.2));
    for (const boundary of [1/3, 2/3]) {
      const before = sceneAt(boundary - .00001).layers.flat();
      const after = sceneAt(boundary + .00001).layers.flat();
      before.forEach((value, index) => assert.ok(Math.abs(value - after[index]) < .01));
    }
  });
  it('compresses vertical travel on phones without changing story state', () => {
    const regular = sceneAt(1/3);
    const phone = sceneAt(1/3, true);
    assert.equal(phone.chapter, regular.chapter);
    phone.layers.forEach((pose, i) => {
      assert.equal(pose[0], regular.layers[i][0]);
      assert.equal(pose[1], regular.layers[i][1] * .66);
    });
  });
});
