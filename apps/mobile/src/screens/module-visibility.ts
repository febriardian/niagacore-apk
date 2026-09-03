import type {RecordKind} from "@/lib/remote-store";
const inventoryGroups=new Set(["Pembelian","Persediaan","Katalog"]);
export function isWorkflowModuleVisible(modules:string[],kind:RecordKind,group:string){const inventoryBusiness=modules.some(module=>["retail","food_service","wholesale"].includes(module));if(group==="F&B")return modules.includes("food_service");if(group==="Jasa")return modules.includes("services");if(kind==="price_list")return modules.includes("wholesale");if(inventoryGroups.has(group)&&!inventoryBusiness)return false;return true}
