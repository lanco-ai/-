import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString('hex');
export const hash = value => createHash('sha256').update(value).digest('hex');
export class HttpError extends Error {
  constructor(status, message, fields) { super(message); this.status = status; this.fields = fields; }
}
export function check(condition, status, message, fields) { if (!condition) throw new HttpError(status, message, fields); }
export function passwordRules(password) {
  check(typeof password === 'string' && password.length >= 12 && password.length <= 128,
    400, '密码应为 12–128 位');
}
export async function passwordHash(password) {
  passwordRules(password);
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [, salt, expected] = (encoded || '').split('$');
  const actual = await derive(password, salt || '00000000000000000000000000000000', 64,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return !!expected && timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
export function text(value, name, max = 1000, required = true) {
  check(typeof value === 'string', 400, `${name}格式不正确`);
  value = value.trim();
  check((!required || value.length > 0) && value.length <= max, 400, `${name}应为${required?'1':'0'}–${max}字`);
  return value;
}
export function username(value) {
  check(typeof value === 'string' && /^[a-zA-Z0-9_]{4,32}$/.test(value), 400, '账号应为 4–32 位字母、数字或下划线');
  return value.toLowerCase();
}
export function chinaDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit',day:'2-digit' }).format(new Date()); }
export function dateValid(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}
export function profileData(data) {
  check(data && typeof data === 'object' && !Array.isArray(data), 400, '请填写宝宝信息');
  const errors = {};
  const out = {};
  for (const [key, label, max, required] of [
    ['baby','宝宝姓名',40,true],['age','宝宝月龄',2,true],['gender','性别',2,true],
    ['allergy','过敏史',2,true],['allergyNote','过敏情况',1000,false],['notes','特殊注意事项',1000,false],
    ['parent','家长姓名',40,true],['phone','联系电话',20,true],['emergency','紧急联系人',100,true]
  ]) {
    const v = typeof data[key] === 'number' && key === 'age' ? String(data[key]) : data[key];
    out[key] = typeof v === 'string' ? v.trim() : '';
    if ((required && !out[key]) || out[key].length > max) errors[key] = `请正确填写${label}`;
  }
  if (!/^\d{1,2}$/.test(out.age) || Number(out.age) > 36) errors.age = '请输入 0–36 之间的整数月龄';
  if (!['男','女'].includes(out.gender)) errors.gender = '请选择性别';
  if (!['有','无'].includes(out.allergy)) errors.allergy = '请选择过敏史';
  if (out.allergy === '有' && !out.allergyNote) errors.allergyNote = '请填写过敏情况';
  if (!/^1\d{10}$/.test(out.phone)) errors.phone = '请输入 11 位手机号码';
  if (!/[\p{L}]/u.test(out.emergency) || !/\d{7,}/.test(out.emergency.replace(/[\s-]/g,''))) errors.emergency = '请填写姓名及有效联系电话';
  check(Object.keys(errors).length === 0, 400, '请检查表单中的信息', errors);
  return out;
}
export function signatureData(value) {
  check(typeof value === 'string' && value.length < 350000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value), 400, '请重新签名');
  const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
  check(bytes.length > 100 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))
    && bytes.length >= 24 && bytes.readUInt32BE(16) === 1000 && bytes.readUInt32BE(20) === 250,
    400, '签名图片格式不正确');
  // Canvas emits non-interlaced RGBA PNG. Decode its bounded pixel buffer so a blank
  // or transparent canvas cannot bypass server-side signature validation.
  try {
    check(bytes[24]===8&&bytes[25]===6&&bytes[26]===0&&bytes[27]===0&&bytes[28]===0,400,'签名图片格式不正确');
    let offset=8,ended=false;const blocks=[];
    while(offset+12<=bytes.length){
      const size=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);
      check(size<=bytes.length-offset-12,400,'签名图片已损坏');
      if(type==='IDAT')blocks.push(bytes.subarray(offset+8,offset+8+size));
      offset+=size+12;if(type==='IEND'){ended=true;break;}
    }
    check(ended&&blocks.length>0,400,'签名图片已损坏');
    const raw=inflateSync(Buffer.concat(blocks),{maxOutputLength:1000250});
    check(raw.length===1000250,400,'签名图片已损坏');
    let previous=Buffer.alloc(4000),ink=0;
    for(let y=0;y<250;y++){
      const type=raw[y*4001];check(type<=4,400,'签名图片已损坏');const row=Buffer.alloc(4000);
      for(let x=0;x<4000;x++){
        const a=x>=4?row[x-4]:0,b=previous[x],c=x>=4?previous[x-4]:0;
        const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
        const predictor=type===0?0:type===1?a:type===2?b:type===3?Math.floor((a+b)/2):pa<=pb&&pa<=pc?a:pb<=pc?b:c;
        row[x]=(raw[y*4001+1+x]+predictor)&255;
      }
      for(let x=0;x<4000;x+=4)if(row[x+3]>32&&Math.min(row[x],row[x+1],row[x+2])<220)ink++;
      previous=row;
    }
    check(ink>=30,400,'签名为空，请先完成手写签名');
  } catch(error) { if(error instanceof HttpError)throw error;throw new HttpError(400,'签名图片已损坏'); }
  return value;
}
