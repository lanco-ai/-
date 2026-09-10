export function fillAgreement(template,profile,organization){
  const values={organization:organization||'',baby:profile.baby,age:profile.age,parent:profile.parent,phone:profile.phone,date:profile.date,teacher:'待分配（签署时）'};
  return String(template).replace(/\{\{(organization|baby|age|parent|phone|date|teacher)\}\}/g,(_,key)=>String(values[key]??'待填写'));
}
