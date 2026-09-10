import {deflateSync} from 'node:zlib';
// Generate a valid 1000x250 PNG with a visible signature-like stroke, without browser dependencies.
export function png(blank=false){
  function crc(buf){let n=0xffffffff;for(const b of buf){n^=b;for(let k=0;k<8;k++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;}
  function chunk(name,data){const type=Buffer.from(name),len=Buffer.alloc(4),c=Buffer.alloc(4);len.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([len,type,data,c]);}
  const header=Buffer.alloc(13);header.writeUInt32BE(1000);header.writeUInt32BE(250,4);header[8]=8;header[9]=6;
  const pixels=Buffer.alloc((1000*4+1)*250,255);for(let y=0;y<250;y++){pixels[y*4001]=0;for(let x=0;x<1000;x++)if(!blank&&x>50&&x<400&&Math.abs(y-(50+x/4))<3){const p=y*4001+1+x*4;pixels[p]=40;pixels[p+1]=70;pixels[p+2]=45;}}
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
