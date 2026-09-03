export type Row=Record<string,unknown>;
export type Kind="overview"|"forecast"|"anomaly"|"finance"|"sales"|"customers"|"ask";
export type Evidence={id:string;label:string;detail:string};
export type DataQuality={level:"limited"|"fair"|"good";label:string;score:number;observedDays:number;windowDays:number};
export type Signal={id:string;kind:string;severity:"medium"|"high";count:number;detail:string;evidence:Evidence[]};
export type DriftMetric={name:string;value:number;threshold:number;status:"stable"|"warning"|"drift";baseline:number;observed:number};
export type Forecast={
  product:string;status:"ready"|"limited_data";model:"naive"|"moving_average_7"|"exponential_smoothing"|"croston";
  movingAverage7:number;movingAverage30:number;forecast:number;predictionLow:number;predictionHigh:number;
  backtestWape:number|null;stock:number;reorderPoint:number;suggestedOrder:number;daysUntilStockout:number|null;
  observedDays:number;seasonalFactor:number;peakWeekday:number|null;
};
export type Analytics={
  windowDays:number;currency:"IDR";sales:Row;salesByDay:Row[];
  finance:{receivablesMinor:number;payablesMinor:number;expensesMinor:number};
  forecasts:Forecast[];anomalies:Signal[];
  customers:{knownCustomers:number;segments:Record<string,number>;method:string;consentRequiredForPromotion:true};
  dataQuality:DataQuality;methods:string[];drift:DriftMetric[];
};
export type Insight={
  title:string;summary:string;dataWindow:string;recommendations:string[];evidence:string[];evidenceIds:string[];
  dataQuality:DataQuality;signalStrength:"low"|"medium"|"high";
};

export const num=(value:unknown)=>Number.isFinite(Number(value))?Number(value):0;
export function classifyNiaQuestion(question:string):Kind{
  const value=question.toLocaleLowerCase("id-ID").replace(/[^a-z0-9\s]/g," ");
  if(/\b(bagaimana cara|cara|panduan|prosedur|aturan|di mana|dimana|menu|fitur)\b/.test(value))return"ask";
  if(/\b(stok apa|perlu dipesan|pesan ulang|pemesanan ulang|reorder|restok|stok habis|stok menipis)\b/.test(value)||/\b(barang|produk|stok)\b.*\b(diperbanyak|ditambah|dipesan|dibeli|disiapkan)\b/.test(value))return"forecast";
  if(/\b(refund tinggi|diskon tidak biasa|selisih kas|margin negatif|transaksi duplikat|stok minus|anomali|risiko)\b/.test(value))return"anomaly";
  if(/\b(pelanggan|rfm|loyal|berhenti membeli|promo pelanggan|pelanggan kembali)\b/.test(value))return"customers";
  if(/\b(piutang|utang|laba|rugi|beban|keuangan|arus kas|neraca)\b/.test(value))return"finance";
  if(/\b(penjualan|pendapatan|omzet|produk terlaris|barang terlaris|produk.*ditingkatkan|kinerja produk|tren)\b/.test(value))return"sales";
  if(/\b(kinerja|usaha|ringkasan)\b/.test(value))return"overview";
  return"ask";
}
const money=(value:unknown)=>`Rp${Math.round(num(value)).toLocaleString("id-ID")}`;
const rows=(value:unknown):Row[]=>Array.isArray(value)?value.filter((item):item is Row=>Boolean(item)&&typeof item==="object"):[];
const round=(value:number,digits=2)=>Number(value.toFixed(digits));
const average=(values:number[])=>values.reduce((sum,value)=>sum+value,0)/Math.max(1,values.length);
const median=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]??0:((sorted[middle-1]??0)+(sorted[middle]??0))/2;};
const stddev=(values:number[])=>{const mean=average(values);return Math.sqrt(average(values.map(value=>(value-mean)**2)));};

function dateKey(date:Date){return date.toISOString().slice(0,10);}
function jakartaDateKey(date=new Date()){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Jakarta",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date),value=(type:string)=>parts.find(part=>part.type===type)?.value??"";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
function dailySeries(data:Row[],windowDays:number,valueKey:string){
  const map=new Map(data.map(row=>[String(row.date),Math.max(0,num(row[valueKey]))]));
  const result:{date:string;value:number;weekday:number}[]=[];
  const now=new Date(`${jakartaDateKey()}T00:00:00.000Z`);
  for(let offset=windowDays-1;offset>=0;offset--){const cursor=new Date(now);cursor.setUTCDate(cursor.getUTCDate()-offset);const date=dateKey(cursor);result.push({date,value:map.get(date)??0,weekday:cursor.getUTCDay()});}
  return result;
}
function ewma(values:number[],alpha=.35){let value=values[0]??0;for(const point of values.slice(1))value=alpha*point+(1-alpha)*value;return value;}
function croston(values:number[],alpha=.2){
  let demand=0,interval=1,last=-1,estimate=0;
  for(let i=0;i<values.length;i++)if(values[i]>0){const gap=last<0?1:i-last;demand=demand===0?values[i]:alpha*values[i]+(1-alpha)*demand;interval=last<0?gap:alpha*gap+(1-alpha)*interval;estimate=interval>0?demand/interval:0;last=i;}
  return estimate;
}
function predict(model:Forecast["model"],history:number[]){
  if(model==="naive")return history[history.length-1]??0;
  if(model==="moving_average_7")return average(history.slice(-7));
  if(model==="croston")return croston(history);
  return ewma(history);
}
function chooseModel(values:number[]){
  const models:Forecast["model"][]=["naive","moving_average_7","exponential_smoothing","croston"];
  const start=Math.max(7,values.length-Math.min(21,Math.max(7,Math.floor(values.length*.25))));
  const scored=models.map(model=>{
    const actual:number[]=[],forecast:number[]=[];
    for(let index=start;index<values.length;index++){actual.push(values[index]);forecast.push(Math.max(0,predict(model,values.slice(0,index))));}
    const absolute=actual.reduce((sum,value,index)=>sum+Math.abs(value-forecast[index]),0),denominator=actual.reduce((sum,value)=>sum+Math.abs(value),0);
    return{model,wape:denominator>0?absolute/denominator:absolute/Math.max(1,actual.length),residuals:actual.map((value,index)=>value-forecast[index])};
  }).sort((a,b)=>a.wape-b.wape);
  return scored[0]??{model:"naive" as const,wape:0,residuals:[]};
}

function demandAnalytics(dataset:Row):Forecast[]{
  const products=rows(dataset.products).map(item=>({id:String(item.id),name:String(item.name??"Produk"),stock:num(item.stock),minimumStock:num(item.minimumStock),leadTimeDays:Math.max(1,num(item.leadTimeDays)||7)}));
  const demand=rows(dataset.productDemand),windowDays=Math.max(7,num(dataset.windowDays)||90);
  return products.map(product=>{
    const series=dailySeries(demand.filter(row=>String(row.productId)===product.id),windowDays,"quantity"),values=series.map(item=>item.value),observedDays=values.filter(value=>value>0).length;
    const movingAverage7=average(values.slice(-7)),movingAverage30=average(values.slice(-30)),selected=chooseModel(values),forecast=Math.max(0,predict(selected.model,values));
    const residualDeviation=stddev(selected.residuals),predictionLow=Math.max(0,forecast-1.65*residualDeviation),predictionHigh=Math.max(forecast,forecast+1.65*residualDeviation);
    const recent=values.slice(-30),demandStd=stddev(recent),weekdays=Array.from({length:7},(_,weekday)=>({weekday,average:average(series.filter(item=>item.weekday===weekday).map(item=>item.value))})).sort((a,b)=>b.average-a.average);
    const dailyDemand=Math.max(forecast,movingAverage30),safetyStock=Math.max(product.minimumStock,1.65*demandStd*Math.sqrt(product.leadTimeDays)),reorderPoint=Math.ceil(dailyDemand*product.leadTimeDays+safetyStock),ready=windowDays>=28&&observedDays>=8;
    return{product:product.name,status:ready?"ready":"limited_data",model:selected.model,movingAverage7:round(movingAverage7),movingAverage30:round(movingAverage30),forecast:round(forecast),predictionLow:round(predictionLow),predictionHigh:round(predictionHigh),backtestWape:ready?round(selected.wape,3):null,stock:round(product.stock),reorderPoint,suggestedOrder:ready?Math.max(0,Math.ceil(reorderPoint-product.stock)):0,daysUntilStockout:ready&&dailyDemand>0?round(Math.max(0,product.stock/dailyDemand),1):null,observedDays,peakWeekday:weekdays[0]?.average?weekdays[0].weekday:null,seasonalFactor:movingAverage30>0?round(Math.max(.5,Math.min(2,(weekdays[0]?.average??movingAverage30)/movingAverage30))):1};
  }).sort((a,b)=>b.suggestedOrder-a.suggestedOrder||(a.daysUntilStockout??9999)-(b.daysUntilStockout??9999)).slice(0,30);
}

function anomalyAnalytics(dataset:Row):Signal[]{
  const metrics=(dataset.anomalyMetrics??{}) as Row,calibration=(dataset.anomalyCalibration??{}) as Row,observations=(dataset.anomalyObservations??{}) as Row,signals:Signal[]=[];
  const refundThreshold=Math.max(0,num(calibration.refundRatio)||.10),discountThreshold=Math.max(0,num(observations.discountRatioThreshold)||num(calibration.discountRatio)||.20),madThreshold=Math.max(1,num(calibration.robustMad)||3.5),cashThreshold=Math.max(0,num(calibration.cashVarianceMinor));
  const add=(id:string,kind:string,severity:"medium"|"high",count:number,detail:string,evidence:Evidence[])=>{if(count>0)signals.push({id,kind,severity,count,detail,evidence});};
  add("NEGATIVE_STOCK","Stok negatif","high",num(metrics.negativeStockProducts),"Cocokkan stok fisik dengan riwayat pergerakan sebelum membuat koreksi.",[{id:"NEGATIVE_STOCK_COUNT",label:"Produk stok negatif",detail:`${num(metrics.negativeStockProducts)} produk`}]);
  add("NEGATIVE_MARGIN","Margin negatif","high",num(metrics.negativeMarginTransactions),"Tinjau HPP, harga jual, dan diskon pada transaksi terkait.",[{id:"NEGATIVE_MARGIN_COUNT",label:"Transaksi margin negatif",detail:`${num(metrics.negativeMarginTransactions)} transaksi`}]);
  const highDiscountTransactions=observations.highDiscountTransactions===undefined?num(metrics.highDiscountTransactions):num(observations.highDiscountTransactions);
  add("UNUSUAL_DISCOUNT","Diskon tidak biasa","medium",highDiscountTransactions,"Periksa otorisasi transaksi dengan diskon di atas batas tinjauan merchant.",[{id:"HIGH_DISCOUNT_COUNT",label:`Diskon di atas ${round(discountThreshold*100,1)}%`,detail:`${highDiscountTransactions} transaksi`}]);
  add("POSSIBLE_DUPLICATE","Kemungkinan duplikat","medium",num(metrics.possibleDuplicateGroups),"Bandingkan waktu, kasir, nominal, pembayaran, dan struk sebelum melakukan tindakan.",[{id:"DUPLICATE_GROUP_COUNT",label:"Kelompok transaksi serupa",detail:`${num(metrics.possibleDuplicateGroups)} kelompok`}]);
  if(num(metrics.refundRatio)>refundThreshold)add("HIGH_REFUND","Refund tinggi","high",1,"Tinjau alasan dan otorisasi refund pada periode ini.",[{id:"REFUND_RATIO",label:"Rasio refund",detail:`${round(num(metrics.refundRatio)*100,1)}% (batas ${round(refundThreshold*100,1)}%)`}]);
  if(num(metrics.cashVarianceMinor)>cashThreshold)add("CASH_VARIANCE","Selisih kas","medium",1,"Cocokkan kas fisik, transaksi tunai, dan catatan buka-tutup shift.",[{id:"CASH_VARIANCE_TOTAL",label:"Total selisih kas absolut",detail:`${money(metrics.cashVarianceMinor)} (batas ${money(cashThreshold)})`}]);

  const windowDays=Math.max(7,num(dataset.windowDays)||90),series=dailySeries(rows(dataset.salesByDay),windowDays,"revenueMinor");
  const today=jakartaDateKey(),usable=series.filter(point=>point.date!==today),latest=usable[usable.length-1],baseline=usable.slice(Math.max(0,usable.length-61),-1).map(point=>point.value);
  if(latest&&baseline.length>=14){
    const center=median(baseline),mad=median(baseline.map(value=>Math.abs(value-center))),score=mad>0?.6745*(latest.value-center)/mad:latest.value>Math.max(0,center)*2&&latest.value>0?10:0;
    if(score>=madThreshold&&latest.value>center){
      add("SALES_SPIKE","Lonjakan penjualan","medium",1,"Pastikan transaksi, pembayaran, dan stok pada hari tersebut telah tercatat dengan benar.",[
        {id:"SALES_SPIKE_ACTUAL",label:"Penjualan aktual",detail:`${money(latest.value)} pada ${latest.date}`},
        {id:"SALES_SPIKE_BASELINE",label:"Median pembanding",detail:`${money(center)} dari ${baseline.length} hari sebelumnya`},
        {id:"SALES_SPIKE_SCORE",label:"Skor robust",detail:`${round(score,2)} MAD (batas ${round(madThreshold,2)})`},
      ]);
    }
  }
  return signals;
}

function driftAnalytics(dataset:Row):DriftMetric[]{
  const series=dailySeries(rows(dataset.salesByDay),Math.max(35,num(dataset.windowDays)||90),"revenueMinor"),values=series.map(item=>item.value);
  const observed=average(values.slice(-7)),baseline=average(values.slice(-35,-7));
  if(values.filter(value=>value>0).length<8)return[];
  const value=baseline>0?Math.abs(observed-baseline)/baseline:observed>0?1:0,threshold=.50;
  return[{name:"sales_mean_relative_change",value:round(value,4),threshold,status:value>=threshold?"drift":value>=threshold*.7?"warning":"stable",baseline:round(baseline),observed:round(observed)}];
}

function customerAnalytics(dataset:Row){
  const data=rows(dataset.customerRfm),segments:Record<string,number>={champion:0,loyal:0,promising:0,at_risk:0,hibernating:0};
  for(const row of data){const recency=num(row.recencyDays),frequency=num(row.frequency),monetary=num(row.monetaryMinor);const segment=recency<=30&&frequency>=5&&monetary>=1_000_000?"champion":recency<=60&&frequency>=3?"loyal":recency<=30?"promising":recency<=120&&frequency>=2?"at_risk":"hibernating";segments[segment]++;}
  return{knownCustomers:data.length,segments,method:"RFM deterministic v1",consentRequiredForPromotion:true as const};
}

export function enrich(dataset:Row):Analytics{
  const windowDays=Math.max(7,num(dataset.windowDays)||90),salesByDay=rows(dataset.salesByDay),observedDays=salesByDay.filter(row=>num(row.transactions)>0).length,coverage=Math.min(1,observedDays/Math.min(windowDays,30));
  const dataQuality:DataQuality=coverage>=.7?{level:"good",label:"Data memadai",score:round(coverage),observedDays,windowDays}:coverage>=.3?{level:"fair",label:"Data sedang",score:round(coverage),observedDays,windowDays}:{level:"limited",label:"Data terbatas",score:round(coverage),observedDays,windowDays};
  return{windowDays,currency:"IDR",sales:(dataset.sales??{}) as Row,salesByDay,finance:{receivablesMinor:num(dataset.openReceivablesMinor),payablesMinor:num(dataset.openPayablesMinor),expensesMinor:num(dataset.expensesMinor)},forecasts:demandAnalytics(dataset),anomalies:anomalyAnalytics(dataset),customers:customerAnalytics(dataset),dataQuality,drift:driftAnalytics(dataset),methods:["naive_baseline","moving_average_7_30","exponential_smoothing_alpha_0_35","croston_intermitt_demand","rolling_backtest_wape","prediction_interval_90","weekday_seasonality","reorder_point_with_safety_stock","merchant_calibrated_anomaly_thresholds","robust_mad_sales_anomaly","deterministic_operational_rules","rfm_v1","sales_distribution_drift_v1"]};
}

function evidenceOf(items:Evidence[]){return{evidence:items.map(item=>`${item.label}: ${item.detail}`),evidenceIds:items.map(item=>item.id)};}
export function deterministicInsight(kind:Kind,analytics:Analytics,question?:string):Insight{
  const sales=analytics.sales,count=num(sales.count),revenue=num(sales.revenueMinor),days=analytics.windowDays,quality=analytics.dataQuality;
  const base={dataWindow:`${days} hari`,dataQuality:quality,signalStrength:"low" as const};
  if(kind==="forecast"){
    const first=analytics.forecasts.find(item=>item.status==="ready"&&item.suggestedOrder>0),limited=analytics.forecasts.filter(item=>item.status==="limited_data").length;
    if(!analytics.forecasts.length)return{...base,title:"Belum ada produk untuk diprediksi",summary:"Tambahkan produk dan catat penjualannya agar NIA dapat menghitung kebutuhan pemesanan.",recommendations:["Tambahkan produk beserta stok minimum","Catat penjualan produk secara konsisten"],...evidenceOf([{id:"FORECAST_PRODUCT_COUNT",label:"Produk dianalisis",detail:"0 produk"}])};
    if(!first)return{...base,title:limited?"Data stok belum cukup":"Belum perlu memesan ulang",summary:limited?"Belum ada produk dengan riwayat penjualan yang cukup untuk menghitung kebutuhan pemesanan secara andal.":"Semua produk yang dapat dianalisis masih berada di atas batas pemesanan ulang.",recommendations:limited?["Lengkapi stok minimum dan lead time pemasok","Gunakan setelah sedikitnya 8 hari memiliki penjualan dalam periode 28 hari"]:["Tetap cocokkan stok aplikasi dengan stok fisik"],...evidenceOf([{id:"FORECAST_READY_COUNT",label:"Produk siap diprediksi",detail:`${analytics.forecasts.length-limited} produk`},{id:"FORECAST_LIMITED_COUNT",label:"Data produk terbatas",detail:`${limited} produk`}])};
    const modelLabel={naive:"Naive",moving_average_7:"Moving average 7 hari",exponential_smoothing:"Exponential smoothing",croston:"Croston"}[first.model];
    return{...base,signalStrength:first.backtestWape!==null&&first.backtestWape<=.3?"high":"medium",title:"Prioritas pemesanan ulang",summary:`${first.product} disarankan ditinjau untuk pemesanan ${first.suggestedOrder} unit. Saran hanya digunakan setelah stok fisik dan lead time dikonfirmasi.`,recommendations:["Periksa stok fisik sebelum membuat pesanan","Pastikan lead time dan stok minimum pemasok sudah benar"],...evidenceOf([{id:"FORECAST_MODEL",label:"Model terpilih",detail:modelLabel},{id:"FORECAST_VALUE",label:"Perkiraan permintaan harian",detail:`${first.forecast} unit (rentang ${first.predictionLow}–${first.predictionHigh})`},{id:"FORECAST_ERROR",label:"WAPE backtest",detail:first.backtestWape===null?"Belum cukup data":`${round(first.backtestWape*100,1)}%`},{id:"REORDER_POINT",label:"Reorder point",detail:`${first.reorderPoint} unit`}])};
  }
  if(kind==="anomaly"){
    const signals=analytics.anomalies,allEvidence=signals.flatMap(signal=>signal.evidence);
    if(!signals.length&&quality.level==="limited")return{...base,title:"Data belum cukup untuk memeriksa risiko",summary:`Baru ${quality.observedDays} hari memiliki transaksi dalam periode ${days} hari. NIA belum dapat menyatakan kondisi normal atau tidak biasa.`,recommendations:["Gunakan pemeriksaan risiko setelah transaksi mulai tercatat secara konsisten"],...evidenceOf([{id:"OBSERVED_DAYS",label:"Hari dengan transaksi",detail:`${quality.observedDays} dari ${days} hari`}])};
    return{...base,signalStrength:signals.some(item=>item.severity==="high")?"high":signals.length?"medium":"low",title:signals.length?"Temuan operasional perlu ditinjau":"Tidak ditemukan risiko yang melewati batas",summary:signals.length?`${signals.length} jenis sinyal melewati batas pemeriksaan. Sinyal adalah petunjuk untuk diperiksa, bukan bukti kesalahan.`:"Pada data yang tersedia, tidak ada aturan atau skor statistik yang melewati batas tinjauan.",recommendations:signals.slice(0,3).map(item=>item.detail),...evidenceOf(allEvidence.slice(0,8))};
  }
  if(kind==="customers"){
    if(analytics.customers.knownCustomers===0)return{...base,title:"Belum ada data pelanggan",summary:"Transaksi belum memiliki pelanggan yang dapat dianalisis. NIA tidak akan membuat segmen dari data kosong.",recommendations:["Hubungkan pelanggan ke transaksi dengan persetujuan mereka","Ulangi analisis setelah terdapat pelanggan yang kembali bertransaksi"],...evidenceOf([{id:"RFM_CUSTOMER_COUNT",label:"Pelanggan dapat dianalisis",detail:"0 pelanggan"}])};
    const entries=Object.entries(analytics.customers.segments),evidence=entries.map(([segment,total])=>({id:`RFM_${segment.toUpperCase()}`,label:segment.replace("_"," "),detail:`${total} pelanggan`}));
    return{...base,signalStrength:analytics.customers.knownCustomers>=20?"high":analytics.customers.knownCustomers>=5?"medium":"low",title:analytics.customers.knownCustomers<5?"Data pelanggan masih awal":"Segmentasi pelanggan RFM",summary:`${analytics.customers.knownCustomers} pelanggan dikelompokkan berdasarkan waktu transaksi terakhir, frekuensi, dan nilai belanja. ${analytics.customers.knownCustomers<5?"Jumlah ini belum cukup untuk keputusan promosi.":"Segmentasi ini berbasis aturan, bukan prediksi perilaku pribadi."}`,recommendations:analytics.customers.knownCustomers<5?["Kumpulkan transaksi pelanggan dengan persetujuan mereka"]:["Gunakan promo hanya untuk pelanggan yang telah memberi persetujuan","Bandingkan perubahan segmen dari waktu ke waktu"],...evidenceOf(evidence.filter(item=>!item.detail.startsWith("0 ")))};
  }
  if(kind==="ask")return{...base,title:"Jawaban belum ditemukan",summary:question?`Belum ditemukan sumber yang cukup untuk menjawab “${question.slice(0,120)}”.`:"Masukkan pertanyaan yang lebih spesifik.",recommendations:["Tambahkan panduan terkait pada Basis Pengetahuan NIA"],...evidenceOf([{id:"RAG_NO_SOURCE",label:"Basis pengetahuan",detail:"Tidak ada bagian dokumen yang melewati ambang relevansi"}])};
  if(kind==="finance"){
    const hasFinance=count>0||revenue>0||analytics.finance.receivablesMinor>0||analytics.finance.payablesMinor>0||analytics.finance.expensesMinor>0;
    return{...base,signalStrength:hasFinance&&quality.level==="good"?"high":hasFinance?"medium":"low",title:hasFinance?"Ringkasan keuangan":"Belum ada data keuangan",summary:hasFinance?`Pendapatan ${money(revenue)}, piutang ${money(analytics.finance.receivablesMinor)}, utang ${money(analytics.finance.payablesMinor)}, dan beban ${money(analytics.finance.expensesMinor)}.`:`Belum ada transaksi, piutang, utang, atau beban yang dapat diringkas dalam ${days} hari.`,recommendations:hasFinance?["Tinjau piutang terbuka dan jatuh tempo","Siapkan kas untuk kewajiban yang akan dibayar"]:["Catat transaksi dan beban terlebih dahulu"],...evidenceOf([{id:"SALES_REVENUE",label:"Pendapatan",detail:money(revenue)},{id:"SALES_COUNT",label:"Transaksi lunas",detail:`${count} transaksi`},{id:"DATA_WINDOW",label:"Periode",detail:`${days} hari`}])};
  }
  if(count===0)return{...base,title:kind==="sales"?"Belum ada data penjualan":"Belum ada aktivitas usaha",summary:`Belum ada transaksi lunas dalam ${days} hari, sehingga NIA belum dapat menilai tren atau memberi rekomendasi peningkatan.`,recommendations:["Catat transaksi penjualan terlebih dahulu","Ulangi analisis setelah data mulai terkumpul"],...evidenceOf([{id:"SALES_COUNT",label:"Transaksi lunas",detail:"0 transaksi"},{id:"SALES_REVENUE",label:"Pendapatan",detail:"Rp0"}])};
  return{...base,signalStrength:quality.level==="good"?"high":quality.level==="fair"?"medium":"low",title:kind==="sales"?"Ringkasan penjualan":"Ringkasan usaha",summary:`${count} transaksi lunas menghasilkan ${money(revenue)} dalam ${days} hari.`,recommendations:analytics.anomalies.length?["Tinjau sinyal operasional sebelum mengambil keputusan","Periksa produk yang mendekati reorder point"]:["Pantau tren, margin, dan reorder point secara berkala"],...evidenceOf([{id:"SALES_COUNT",label:"Transaksi lunas",detail:`${count} transaksi`},{id:"SALES_REVENUE",label:"Pendapatan",detail:money(revenue)},{id:"ANOMALY_COUNT",label:"Sinyal tinjauan",detail:`${analytics.anomalies.length} jenis`}])};
}
