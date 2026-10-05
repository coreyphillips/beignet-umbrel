import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { click, render, type } from "../../test/render.mjs";
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
