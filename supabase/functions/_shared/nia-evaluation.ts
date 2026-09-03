import {classifyNiaQuestion} from "./decision-intelligence.ts";

export type EvaluationCase={
  id:string;
  question:string;
  expected_intent:string;
  reference_answer:string;
  required_facts:unknown;
  forbidden_claims:unknown;
};

const tokens=(value:string)=>value
  .toLocaleLowerCase("id-ID")
  .normalize("NFKD")
  .replace(/[^a-z0-9\s]/g," ")
  .split(/\s+/)
  .filter(token=>token.length>1);
const list=(value:unknown)=>Array.isArray(value)?value.filter((item):item is string=>typeof item==="string"):[];
const overlap=(left:string,right:string)=>{
  const a=new Set(tokens(left)),b=new Set(tokens(right));
  if(!a.size||!b.size)return 0;
  const common=[...a].filter(item=>b.has(item)).length;
  return (2*common)/(a.size+b.size);
};
const factMatch=(answer:string,fact:string)=>{
  const answerTokens=new Set(tokens(answer)),factTokens=[...new Set(tokens(fact))];
  if(!factTokens.length)return true;
  return factTokens.filter(token=>answerTokens.has(token)).length/factTokens.length>=.67;
};

export function scoreNiaEvaluation(test:EvaluationCase,answer:string){
  const normalized=answer.toLocaleLowerCase("id-ID"),required=list(test.required_facts),forbidden=list(test.forbidden_claims);
  const found=forbidden.filter(item=>normalized.includes(item.toLocaleLowerCase("id-ID")));
  const grounding=required.length?required.filter(item=>factMatch(answer,item)).length/required.length:1;
  const reference=overlap(answer,test.reference_answer);
  const intentMatch=classifyNiaQuestion(test.question)===test.expected_intent;
  return{grounding,reference,intentMatch,found,passed:Boolean(answer.trim())&&intentMatch&&grounding>=.75&&reference>=.22&&found.length===0};
}

export function evaluationContext(test:EvaluationCase){
  const required=list(test.required_facts),forbidden=list(test.forbidden_claims);
  return [
    `Jawaban acuan: ${test.reference_answer}`,
    required.length?`Fakta yang wajib dipertahankan: ${required.join("; ")}`:"",
    forbidden.length?`Klaim yang dilarang: ${forbidden.join("; ")}`:"",
  ].filter(Boolean).join("\n");
}
