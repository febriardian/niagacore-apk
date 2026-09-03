import {describe,expect,it} from "vitest";
import {evaluationContext,scoreNiaEvaluation,type EvaluationCase} from "./nia-evaluation";

const sample:EvaluationCase={id:"1",question:"Bagaimana cara retur transaksi?",expected_intent:"ask",reference_answer:"Buka Riwayat transaksi, pilih transaksi selesai, lalu ajukan retur sesuai kewenangan.",required_facts:["Riwayat transaksi","retur"],forbidden_claims:["retur selalu otomatis disetujui"]};

describe("NIA evaluation scoring",()=>{
  it("menerima jawaban benar yang diparafrase",()=>{
    expect(scoreNiaEvaluation(sample,"Masuk ke Riwayat transaksi, pilih transaksi selesai, kemudian ajukan retur sesuai kewenangan.").passed).toBe(true);
  });
  it("menolak klaim yang dilarang",()=>{
    expect(scoreNiaEvaluation(sample,"Buka Riwayat transaksi. Retur selalu otomatis disetujui.").passed).toBe(false);
  });
  it("menyertakan fakta wajib pada konteks evaluator",()=>{
    expect(evaluationContext(sample)).toContain("Riwayat transaksi; retur");
  });
});
