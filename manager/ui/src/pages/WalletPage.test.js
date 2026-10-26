import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { click, render, settle, type } from "../../test/render.mjs";
import { manager } from "../api.js";
import { ToastProvider } from "../components/Toast.jsx";
import { EditWalletModal } from "./WalletPage.jsx";
import ffor from "../../../server/ffor.js";

const initial = () => ({
  id: "wallet",
  name: "Primary",
  network: "mainnet",
  onchainOnly: false,
  networkMode: "private",
  electrum: { host: "electrum.test", port: 50002, tls: true },
  ffor: ffor.normalizeFfor({
    settle: { enabled: true },
    concurrent: { enabled: false },
    funding: {
      enabled: false,
      maxChannels: 12,
      maxChannelsPerPeer: 3,
      maxChannelSats: 250000,
      maxTotalSats: 2000000,
    },
  }),
});

test("turning off Lightning also disables automatic funding while preserving its limits", async () => {
  const rec = initial();
  rec.ffor.funding.enabled = true;
  let saved;
  let completed = false;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (path, options) => {
    if (path.endsWith("/channels"))
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    assert.equal(path, "/api/wallets/wallet");
    const body = JSON.parse(options.body);
    saved = { ...rec, ...body, ffor: ffor.normalizeFfor(body.ffor, rec.ffor) };
    return { ok: true, json: async () => ({ ok: true, result: saved }) };
  };
  const r = await render(wrapped, {
    rec,
    presets: [],
    fforAvailable: true,
    onClose() {},
    onSaved() {
      completed = true;
    },
  });
  try {
    await click(
      r
        .$$("label.checkbox")
        .find((label) => label.textContent.includes("Lightning enabled"))
        .querySelector("input"),
    );
    await click(
      r.$$("button").find((button) => button.textContent === "Save changes"),
    );
    assert.equal(completed, true);
    assert.equal(saved.onchainOnly, true);
    assert.equal(saved.ffor.settle.enabled, false);
    assert.deepEqual(saved.ffor.funding, {
      ...rec.ffor.funding,
      enabled: false,
    });
    assert.equal(saved.ffor.concurrent.enabled, false);
  } finally {
    await r.unmount();
    globalThis.fetch = fetchBefore;
  }
});
const wrapped = (props) =>
  createElement(ToastProvider, null, createElement(EditWalletModal, props));

test("automatic receive funding and limits survive save, reopen and unrelated edits", async () => {
  let saved = initial();
  let saves = 0;
  let rendered;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (path, options) => {
    if (path.endsWith("/channels"))
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    assert.equal(path, "/api/wallets/wallet");
    assert.equal(options.method, "PATCH");
    const body = JSON.parse(options.body);
    saved = {
      ...saved,
      ...body,
      ffor: ffor.normalizeFfor(body.ffor, saved.ffor),
    };
    return { ok: true, json: async () => ({ ok: true, result: saved }) };
  };
  const open = async () => {
    rendered = await render(wrapped, {
      rec: saved,
      presets: [],
      fforAvailable: true,
      onClose() {},
      onSaved() {
        saves++;
      },
    });
    return rendered;
  };
  const save = async () =>
    click(
      rendered
        .$$("button")
        .find((button) => button.textContent === "Save changes"),
    );
  try {
    await open();
    assert.equal(rendered.$('[data-testid="ffor-funding"]').checked, false);
    assert.equal(rendered.$('[data-testid="ffor-concurrent"]').checked, false);
    await click(rendered.$('[data-testid="ffor-funding"]'));
    assert.match(rendered.text(), /Changing this restarts the wallet/);
    await save();
    assert.equal(saves, 1);
    assert.equal(saved.ffor.funding.enabled, true);
    const funding = { ...saved.ffor.funding };
    await rendered.unmount();

    await open();
    assert.equal(rendered.$('[data-testid="ffor-funding"]').checked, true);
    assert.equal(rendered.$('[data-testid="ffor-concurrent"]').checked, false);
    for (const value of [12, 3, 250000, 2000000]) {
      assert.ok(
        rendered.$$("input").some((input) => input.value === String(value)),
      );
    }
    await type(rendered.$("input"), "Renamed primary");
    await save();
    assert.equal(saves, 2);
    assert.equal(saved.name, "Renamed primary");
    assert.deepEqual(saved.ffor.funding, funding);
    assert.equal(saved.ffor.concurrent.enabled, false);
    await rendered.unmount();

    await open();
    await click(rendered.$('[data-testid="ffor-funding"]'));
    await click(rendered.$('[data-testid="ffor-concurrent"]'));
    await save();
    assert.equal(saves, 3);
    assert.deepEqual(saved.ffor.funding, { ...funding, enabled: false });
    assert.equal(saved.ffor.concurrent.enabled, true);
    await rendered.unmount();

    await open();
    assert.equal(rendered.$('[data-testid="ffor-funding"]').checked, false);
    assert.equal(rendered.$('[data-testid="ffor-concurrent"]').checked, true);
  } finally {
    await rendered?.unmount();
    globalThis.fetch = fetchBefore;
  }
});

test("a server on another chain is refused with a way through, and Save anyway sends the override", async () => {
  const rec = initial();
  const bodies = [];
  let completed = 0;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (path, options) => {
    if (path.endsWith("/channels"))
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    assert.equal(path, "/api/wallets/wallet");
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (body.allowChainMismatch !== true) {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          error: {
            code: "ELECTRUM_WRONG_CHAIN",
            message:
              "The Electrum server at testnet.example:50002 serves testnet, but this wallet is on mainnet. Pick a mainnet server, or save anyway if you are sure.",
            details: { host: "testnet.example", port: 50002, chain: "testnet", network: "mainnet", software: "electrs/0.10.9" },
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ ok: true, result: { ...rec, ...body } }) };
  };
  const r = await render(wrapped, {
    rec,
    presets: [],
    onClose() {},
    onSaved() {
      completed++;
    },
  });
  try {
    const host = r.$('input[placeholder^="192.168"]');
    await type(host, "testnet.example");
    await click(r.$$("button").find((b) => b.textContent === "Save changes"));
    assert.equal(completed, 0, "the refusal keeps the dialog open");
    const note = r.$('[data-testid="electrum-wrong-chain"]');
    assert.ok(note, "the refusal is shown under the fields");
    assert.match(note.textContent, /serves testnet, but this wallet is on mainnet/);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].allowChainMismatch, undefined);
    await click(r.$('[data-testid="electrum-save-anyway"]'));
    assert.equal(completed, 1);
    assert.equal(bodies[1].allowChainMismatch, true);
    assert.equal(bodies[1].electrum.host, "testnet.example");
  } finally {
    await r.unmount();
    globalThis.fetch = fetchBefore;
  }
});

test("a refusal that lands after the server was changed again does not offer to save the new one anyway", async () => {
  // The guard's probe takes up to a few seconds. Save old-wrong.example,
  // type another host while that is pending, and let the refusal of the
  // first arrive: it is about a server the fields no longer name, so no
  // note, and nothing that would send the new host with the override.
  const rec = initial();
  const bodies = [];
  const pending = [];
  let completed = 0;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (path, options) => {
    if (path.endsWith("/channels"))
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: [] }) });
    assert.equal(path, "/api/wallets/wallet");
    const body = JSON.parse(options.body);
    bodies.push(body);
    return new Promise((resolve) => pending.push({ body, resolve }));
  };
  const refusal = (host) => ({
    ok: false,
    status: 400,
    json: async () => ({
      ok: false,
      error: {
        code: "ELECTRUM_WRONG_CHAIN",
        message: `The Electrum server at ${host}:50002 serves testnet, but this wallet is on mainnet. Pick a mainnet server, or save anyway if you are sure.`,
        details: { host, port: 50002, chain: "testnet", network: "mainnet", software: "electrs/0.10.9" },
      },
    }),
  });
  const r = await render(wrapped, {
    rec,
    presets: [],
    onClose() {},
    onSaved() {
      completed++;
    },
  });
  try {
    const host = r.$('input[placeholder^="192.168"]');
    await type(host, "old-wrong.example");
    await click(r.$$("button").find((b) => b.textContent === "Save changes"));
    assert.equal(pending.length, 1);
    assert.equal(bodies[0].electrum.host, "old-wrong.example");
    await type(host, "new-unchecked.example");
    pending[0].resolve(refusal("old-wrong.example"));
    await settle(0);
    assert.equal(completed, 0);
    assert.equal(r.$('[data-testid="electrum-wrong-chain"]'), null, "the refusal was about a server the fields no longer name");
    assert.equal(r.$('[data-testid="electrum-save-anyway"]'), null, "so nothing offers to save the new one unchecked");
    // Saving the new host asks the manager about it, without the override.
    await click(r.$$("button").find((b) => b.textContent === "Save changes"));
    assert.equal(pending.length, 2);
    assert.equal(bodies[1].electrum.host, "new-unchecked.example");
    assert.equal(bodies[1].allowChainMismatch, undefined);
    pending[1].resolve(refusal("new-unchecked.example"));
    await settle(0);
    assert.ok(r.$('[data-testid="electrum-wrong-chain"]'), "a refusal of the server the fields do name is shown");
    assert.match(r.$('[data-testid="electrum-wrong-chain"]').textContent, /new-unchecked\.example/);
  } finally {
    await r.unmount();
    globalThis.fetch = fetchBefore;
  }
});

const escape = () =>
  act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

test("the Edit dialog offers the recovery phrase to a Lightning and an on-chain only wallet, warning first", async () => {
  const asked = [];
  const phraseBefore = manager.recoveryPhrase;
  manager.recoveryPhrase = async (id) => {
    asked.push(id);
    return { mnemonic: "abandon ".repeat(11) + "about" };
  };
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) });
  try {
    for (const onchainOnly of [false, true]) {
      // Channel backup is off for both: the section must not hang on it.
      const r = await render(wrapped, {
        rec: { ...initial(), onchainOnly },
        presets: [],
        onClose() {},
        onSaved() {},
      });
      try {
        const show = r.$('[data-testid="recovery-phrase"]');
        assert.ok(show, `onchainOnly ${onchainOnly}`);
        assert.equal(show.textContent, "Show recovery phrase");
        assert.match(show.className, /\bghost\b/);
        await click(show);
        assert.match(r.text(), /Recovery phrase for "Primary"/);
        assert.match(r.text(), /Anyone who sees these words can take every coin/);
        assert.equal(r.$('[data-testid="seed-words"]'), null);
        assert.deepEqual(asked, [], "nothing is asked for before Show phrase");
      } finally {
        await r.unmount();
      }
    }
  } finally {
    manager.recoveryPhrase = phraseBefore;
    globalThis.fetch = fetchBefore;
  }
});

test("closing the recovery phrase returns to the Edit dialog with its edits", async () => {
  const phraseBefore = manager.recoveryPhrase;
  manager.recoveryPhrase = async () => ({ mnemonic: "abandon ".repeat(11) + "about" });
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) });
  let closed = 0;
  const r = await render(wrapped, {
    rec: initial(),
    presets: [],
    onClose() {
      closed++;
    },
    onSaved() {},
  });
  try {
    await type(r.$("input"), "Renamed primary");
    await click(r.$('[data-testid="recovery-phrase"]'));
    await click(r.$('[data-testid="reveal-phrase"]'));
    await settle(20);
    assert.ok(r.$('[data-testid="seed-words"]'));

    await escape();
    await settle(250);
    assert.equal(r.$('[data-testid="seed-words"]'), null);
    assert.doesNotMatch(r.text(), /Recovery phrase for/);
    assert.equal(closed, 0, "Escape closed the phrase only");
    assert.match(r.text(), /Edit wallet/);
    assert.equal(r.$("input").value, "Renamed primary");

    // With the phrase gone, Escape is the Edit dialog's again.
    await escape();
    await settle(250);
    assert.equal(closed, 1);
  } finally {
    await r.unmount();
    manager.recoveryPhrase = phraseBefore;
    globalThis.fetch = fetchBefore;
  }
});
