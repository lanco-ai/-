export function fillAgreement(template,profile,organization){
  const values={organization:organization||'',baby:profile.baby,age:profile.age,parent:profile.parent,phone:profile.phone,date:profile.date,address:profile.address,gender:profile.gender,allergy:profile.allergy,allergyNote:profile.allergy==='无'?'无已申报过敏史':(profile.allergyNote||'未填写'),notes:profile.notes||'未填写',emergency:profile.emergency,teacher:'待分配（签署时）'};
  return String(template).replace(/\{\{(organization|baby|age|parent|phone|date|address|gender|allergy|allergyNote|notes|emergency|teacher)\}\}/g,(_,key)=>String(values[key]??'待填写'));
}
