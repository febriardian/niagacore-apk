import {describe,expect,it} from "vitest";

import {classifyNiaQuestion,deterministicInsight,enrich} from "./decision-intelligence";

describe("NIA intent routing",()=>{
  it("routes operational instructions to knowledge",()=>{
    expect(classifyNiaQuestion("Bagaimana cara retur transaksi?")).toBe("ask");
  });

  it("routes stock questions to forecasting",()=>{
    expect(classifyNiaQuestion("Stok apa yang perlu dipesan?")).toBe("forecast");
    expect(classifyNiaQuestion("Barang apa yg perlu diperbanyak?")).toBe("forecast");
    expect(classifyNiaQuestion("Produk mana yang harus ditambah?")).toBe("forecast");
  });

  it("routes product performance to sales",()=>{
    expect(classifyNiaQuestion("Produk apa yang perlu ditingkatkan?")).toBe("sales");
  });

  it("routes unusual transactions to anomaly detection",()=>{
    expect(classifyNiaQuestion("Apakah ada transaksi duplikat atau risiko?")).toBe("anomaly");
  });
});

describe("NIA limited-data guardrails",()=>{
  const empty=enrich({windowDays:30,sales:{count:0,revenueMinor:0},salesByDay:[],products:[],productDemand:[],customerRfm:[],anomalyMetrics:{}});

  it("does not claim that limited anomaly data is normal",()=>{
    expect(deterministicInsight("anomaly",empty).title).toBe("Data belum cukup untuk memeriksa risiko");
  });

  it("does not render empty RFM segments as an analysis",()=>{
    const result=deterministicInsight("customers",empty);
    expect(result.title).toBe("Belum ada data pelanggan");
    expect(result.evidence).toEqual(["Pelanggan dapat dianalisis: 0 pelanggan"]);
  });
});

describe("NIA merchant calibration and drift",()=>{
  it("uses the merchant refund threshold instead of a fixed global threshold",()=>{
    const analytics=enrich({windowDays:30,sales:{count:10,revenueMinor:100000},salesByDay:[],products:[],productDemand:[],customerRfm:[],anomalyMetrics:{refundRatio:.08},anomalyCalibration:{refundRatio:.05,discountRatio:.25,robustMad:4.5,cashVarianceMinor:1000},anomalyObservations:{highDiscountTransactions:0,discountRatioThreshold:.25}});
    expect(analytics.anomalies.some(item=>item.id==="HIGH_REFUND")).toBe(true);
  });

  it("emits a drift measurement when recent sales move far from baseline",()=>{
    const end=new Date(),salesByDay=Array.from({length:35},(_,index)=>{const date=new Date(end);date.setUTCDate(end.getUTCDate()-(34-index));return{date:date.toISOString().slice(0,10),revenueMinor:index<28?100:400,transactions:1};});
    const analytics=enrich({windowDays:35,sales:{count:35,revenueMinor:5600},salesByDay,products:[],productDemand:[],customerRfm:[],anomalyMetrics:{}});
    expect(analytics.drift[0]?.status).toBe("drift");
  });
});
