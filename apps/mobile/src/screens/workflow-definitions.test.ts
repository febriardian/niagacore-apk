import {describe,expect,it} from "vitest";
import {modules,validateWorkflowRecord} from "./workflow-definitions";

describe("blueprint workflow definitions",()=>{
  it("uses a unique definition for every business workflow",()=>{
    expect(new Set(modules.map((module)=>module.kind)).size).toBe(modules.length);
    expect(modules.length).toBeGreaterThanOrEqual(30);
  });
  it("rejects an unbalanced multi-line manual journal",()=>{
    const module=modules.find((item)=>item.kind==="manual_journal")!;
    expect(validateWorkflowRecord(module,{title:"Koreksi",amountMinor:1000,quantity:0,dueAt:null,metadata:{journalLines:[{accountCode:"1101",debitMinor:1000,creditMinor:0},{accountCode:"4101",debitMinor:0,creditMinor:900}],explanation:"Koreksi"}})).toContain("harus sama");
  });
  it("accepts structured bundle components",()=>{
    const module=modules.find((item)=>item.kind==="bundle")!;
    expect(validateWorkflowRecord(module,{title:"Paket hemat",amountMinor:25000,quantity:0,dueAt:null,metadata:{components:[{productId:"p1",quantity:2,unit:"pcs"}]}})).toBeNull();
  });
});
