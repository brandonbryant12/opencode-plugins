import test from "node:test";
import assert from "node:assert/strict";
import { ledger, records, reportMarkdown } from "../src/reports.ts";
import type { State } from "../src/engine.ts";
const defect = { findings: [{location:"orders.ts:4",problem:"Next cursor can repeat"}] };
const fix = (id: string) => ({summary:"Corrected",checks:[{command:"test",result:"pass",evidence:"Passed"}],blocked:[],decisions:[{id,action:"fixed",reason:"Cursor now advances"}]});
function state(outputs: Record<string, unknown>): State { return {version:2,goal:"Fix orders",status:"running",phase:"",reason:"Working",active:[],outputs:Object.fromEntries(Object.entries(outputs).map(([k,v]) => [k,JSON.stringify(v)]))}; }
test("findings link reviewer IDs to decisions and independent evidence", () => {
  const s=state({"round/1/batch/1/review/1":defect,"round/1/batch/1/review/2":defect,"round/1/batch/1/evaluate":fix("1:0"),"round/1/batch/1/verify/0":{findings:[],coverage:[{slice:1,status:"checked",evidence:"Cursor advances"}]}});
  const l=ledger(s);
  assert.equal(l.findings[0].outcome,"verified-fix");
  assert.equal(l.findings[1].repeatedFrom,l.findings[0].id);
  assert.equal(l.coverage[0].receipt,"round/1/batch/1/verify/0");
  assert.match(reportMarkdown(s),/Cursor now advances/);
});
test("another batch's clean final verdict cannot verify this batch's repair", () => {
  const s=state({"final/0/verify/1":defect,"final/0/fix/1":fix("0"),"final/1/verify/1":defect,"final/1/verify/2":{findings:[]}});
  assert.equal(ledger(s).findings[0].verification,null);
});
test("parsed receipts refresh after replacement and deletion during recovery", () => {
  const s=state({"plan":{slices:[]},"round/1/assessment/3":defect});
  assert.equal(records(s).length,2);
  delete s.outputs["round/1/assessment/3"];
  assert.equal(records(s).length,1);
  s.outputs.plan=JSON.stringify({slices:[1]});
  assert.deepEqual(records(s)[0].data.slices,[1]);
});
