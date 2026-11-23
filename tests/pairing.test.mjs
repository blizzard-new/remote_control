import { webcrypto } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { resumeOffers, resumeAnswer } from "../web/pairing.mjs";

globalThis.crypto ??= webcrypto;
const address = "https://test.invalid";
const challenge = "0123456789abcdef0123456789abcdef";
// Public directional keys from the P-256 test vector in PinDirectoryTest.
const host = {
  address,
  name: "Mac",
  listen: "W8j9UP_0_5uoUbe2qUgE6tCuZinmkxsU",
  dial: "a-uLqDClD9V4oTeBKaHTDHCFGbRn3kAA",
  grant: "control",
};
const reverse = (p) => ({ ...p, listen: p.dial, dial: p.listen });

test("returning through a PIN proves both directions for the current exchange", async () => {
  const [proof] = await resumeOffers([reverse(host)], address, challenge);
  assert.equal(proof.offer, "OuiVkSRnEt65Nr7CF8ssxa3pZErzjbm03v_oteSfzZg");
  assert.equal(proof.answer, "_iN3KDUUXBiloUvS__K6L2jjSh3U2K_F7tBkiUOSB5A");
  assert.equal(
    await resumeAnswer([proof.offer], [host], address, challenge),
    proof.answer,
  );
  for (const [offers, pairs, service, nonce] of [
    [[proof.offer], [], address, challenge],
    [[proof.offer], [host], address, "a".repeat(32)],
    [[proof.answer], [host], address, challenge],
    [[proof.offer], [host], "https://different.invalid", challenge],
    [["Mac"], [host], address, challenge],
  ])
    assert.equal(await resumeAnswer(offers, pairs, service, nonce), null);
});

test("multiple proven old records reuse the one already approved for control", async () => {
  const view = {
    ...host,
    listen: "A".repeat(32),
    dial: "B".repeat(32),
    grant: "view",
  };
  const [old, control] = await resumeOffers(
    [reverse(view), reverse(host)],
    address,
    challenge,
  );
  assert.equal(
    await resumeAnswer(
      [old.offer, control.offer],
      [view, host],
      address,
      challenge,
    ),
    control.answer,
  );
  assert.equal(
    await resumeAnswer([old.offer], [view, host], address, challenge),
    old.answer,
  );
});
