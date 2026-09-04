/**
 * A recorded author, so the demo runs offline and identically every time.
 *
 * For a real model, set BOB_MODEL_CMD to any command that reads a prompt on
 * stdin and writes the answer to stdout:
 *
 *   export BOB_MODEL_CMD='claude -p'
 */
import { defineAdapter } from "../src/eval/adapter.js";

const AUTHORED = `t Job applications
why A tracker with the company, role and status of every application, plus counts by stage.
schema {"collections":{"applications":{"path":"/applications","noun":"application","fields":[{"name":"company","label":"Company","type":"text","required":true},{"name":"role","label":"Role","type":"text"},{"name":"status","label":"Status","type":"select","options":["Applied","Interview","Offer","Rejected"]},{"name":"applied","label":"Date applied","type":"date"}]}}}
c app Screen title="Job applications"
r app
> app counts table form
c counts Stack direction=horizontal gap=3
> counts total interviewing offers
c total Metric label="Applications" value={"$count":"/applications"}
c interviewing Metric label="Interviewing" value={"$count":"/applications","where":{"field":"status","equals":"Interview"}}
c offers Metric label="Offers" value={"$count":"/applications","where":{"field":"status","equals":"Offer"}}
c table Table caption="Every application" collection=applications rows=@/applications removable=true columns=[{"field":"company","label":"Company"},{"field":"role","label":"Role"},{"field":"status","label":"Status"},{"field":"applied","label":"Applied"}]
c form Stack gap=2
> form formHeading company role status applied addBtn
c formHeading Heading text="Log an application" level=2
c company Field label="Company" value=@/draft/applications/company
c role Field label="Role" value=@/draft/applications/role
c status Select label="Status" value=@/draft/applications/status options=["Applied","Interview","Offer","Rejected"]
c applied Field label="Date applied" kind=date value=@/draft/applications/applied
c addBtn Button label="Add application" action=add collection=applications variant=primary
`;

const EDITED = `why Added a notes column to the table so you can see why each one mattered.
c table Table caption="Every application" collection=applications rows=@/applications removable=true columns=[{"field":"company","label":"Company"},{"field":"role","label":"Role"},{"field":"status","label":"Status"},{"field":"notes","label":"Notes"}]
c notes Field label="Notes" value=@/draft/applications/notes
> form formHeading company role status applied notes addBtn
`;

export const adapter = defineAdapter("recorded", async function* (system) {
  yield system.includes("You are editing an app") ? EDITED : AUTHORED;
});

export default adapter;
