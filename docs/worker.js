// 計算はWorkerで行い、画面を固めない
import { Sim } from "./solver.js?v=20261016b";
import Module from "./lib/highs.mjs";

const wasmUrl = new URL("./lib/highs.wasm", import.meta.url).href;
const loadHighs = () => Module({ locateFile: () => wasmUrl });
let sim = null;
const ready = (async () => {
  const data = await (await fetch(new URL("./data.json?v=20261016b", import.meta.url))).json();
  sim = new Sim(data, loadHighs);
  await sim.init();
})();

self.onmessage = async (e) => {
  const { id, cmd, req, opts } = e.data;
  try {
    await ready;
    const progress = (i, n) => self.postMessage({ id, progress: [i, n] });
    let result;
    if (cmd === "search") result = await sim.search(req, opts);
    else if (cmd === "additional") result = await sim.additional(req, progress);
    else if (cmd === "suggest") result = await sim.suggestTalismans(req, opts);
    else if (cmd === "kyogeki") result = await sim.kyogekiScan(req);
    else if (cmd === "ping") result = true;
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
