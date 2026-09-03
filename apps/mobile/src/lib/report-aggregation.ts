export interface DashboardAnalytics { dailySales: { label: string; amountMinor: number; transactions: number }[]; topProducts: { name: string; quantity: number; revenueMinor: number }[]; paymentMix: { method: string; amountMinor: number }[]; grossSalesMinor: number; costMinor: number; expenseMinor: number; profitMinor: number; receivableMinor: number; payableMinor: number; lowStockCount: number; previousGrossSalesMinor: number; transactionCount: number; averageTicketMinor: number; periodDays: number; }

export function mergeDashboardAnalytics(rows:DashboardAnalytics[],days:number):DashboardAnalytics{
  const daily=new Map<string,{amountMinor:number;transactions:number}>(),products=new Map<string,{quantity:number;revenueMinor:number}>(),mix=new Map<string,number>();
  for(const row of rows){
    row.dailySales.forEach(item=>{const value=daily.get(item.label)??{amountMinor:0,transactions:0};value.amountMinor+=item.amountMinor;value.transactions+=item.transactions;daily.set(item.label,value)});
    row.topProducts.forEach(item=>{const value=products.get(item.name)??{quantity:0,revenueMinor:0};value.quantity+=item.quantity;value.revenueMinor+=item.revenueMinor;products.set(item.name,value)});
    row.paymentMix.forEach(item=>mix.set(item.method,(mix.get(item.method)??0)+item.amountMinor));
  }
  const sum=(key:keyof Pick<DashboardAnalytics,"grossSalesMinor"|"costMinor"|"expenseMinor"|"profitMinor"|"receivableMinor"|"payableMinor"|"lowStockCount"|"previousGrossSalesMinor"|"transactionCount">)=>rows.reduce((total,row)=>total+row[key],0);
  const grossSalesMinor=sum("grossSalesMinor"),transactionCount=sum("transactionCount");
  return {dailySales:[...daily].sort(([a],[b])=>a.localeCompare(b)).map(([label,value])=>({label,...value})),topProducts:[...products].map(([name,value])=>({name,...value})).sort((a,b)=>b.revenueMinor-a.revenueMinor).slice(0,5),paymentMix:[...mix].map(([method,amountMinor])=>({method,amountMinor})),grossSalesMinor,costMinor:sum("costMinor"),expenseMinor:sum("expenseMinor"),profitMinor:sum("profitMinor"),receivableMinor:sum("receivableMinor"),payableMinor:sum("payableMinor"),lowStockCount:sum("lowStockCount"),previousGrossSalesMinor:sum("previousGrossSalesMinor"),transactionCount,averageTicketMinor:transactionCount?Math.round(grossSalesMinor/transactionCount):0,periodDays:days};
}
