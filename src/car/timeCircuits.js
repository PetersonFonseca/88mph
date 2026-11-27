export const MONTHS=['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
export const FIELDS=[{key:'month',label:'MÊS',size:2},{key:'day',label:'DIA',size:2},{key:'year',label:'ANO',size:4},{key:'hour',label:'HORA',size:2},{key:'minute',label:'MIN',size:2}];
export const isLeapYear=y=>y%4===0&&(y%100!==0||y%400===0);
export function validateDate(d){
  if(!d||!['month','day','year','hour','minute'].every(k=>Number.isInteger(d[k])))return 'Preencha os cinco campos.';
  if(d.year<1||d.year>9999)return 'Escolha um ano entre 0001 e 9999.';
  if(d.month<1||d.month>12)return 'O mês deve estar entre 01 e 12.';
  const days=[31,isLeapYear(d.year)?29:28,31,30,31,30,31,31,30,31,30,31];
  if(d.day<1||d.day>days[d.month-1])return 'Esse dia não existe no mês escolhido.';
  if(d.hour<0||d.hour>23||d.minute<0||d.minute>59)return 'Use uma hora válida no formato 24 h.';
  return null;
}
export function parseDate(input){
  const digits=String(input).replace(/\D/g,'');
  if(digits.length!==12)throw new Error('Digite MÊS, DIA, ANO, HORA e MIN: 12 dígitos.');
  const d={month:+digits.slice(0,2),day:+digits.slice(2,4),year:+digits.slice(4,8),hour:+digits.slice(8,10),minute:+digits.slice(10,12)};
  const error=validateDate(d);if(error)throw new Error(error);return d;
}
export function dateToEra(d){if(d.year<=1899)return 'oldwest';if(d.year<=1984)return 'fifties';return d.year*10000+d.month*100+d.day>20261111?'future':'present';}
export function dateDigits(d){return FIELDS.map(f=>String(d[f.key]).padStart(f.size,'0')).join('');}
export function formatDate(d){return `${String(d.day).padStart(2,'0')} ${MONTHS[d.month-1]} ${String(d.year).padStart(4,'0')} · ${String(d.hour).padStart(2,'0')}:${String(d.minute).padStart(2,'0')}`;}
export class TimeCircuits {
  constructor(now){this.now={...now};this.last={...now};this.destination=null;this.buffer='';this.error='';}
  begin(){this.buffer='';this.error='';}
  type(key){if(/^\d$/.test(key)){if(this.buffer.length<12)this.buffer+=key;this.error='';}else if(key==='Backspace'){this.buffer=this.buffer.slice(0,-1);this.error='';}}
  confirm(){try{this.destination=parseDate(this.buffer);this.error='';return this.destination;}catch(e){this.error=e.message;return null;}}
  arrive(){if(!this.destination)throw new Error('Nenhum destino programado.');this.last={...this.now};this.now={...this.destination};this.destination=null;}
}
