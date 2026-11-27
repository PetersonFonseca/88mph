import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseDate,dateToEra,validateDate,TimeCircuits} from '../src/car/timeCircuits.js';
test('fronteiras das quatro épocas, incluindo o dia exato',()=>{
  for(const [input,era] of [['010118851200','oldwest'],['123118992359','oldwest'],['010119000000','fifties'],['123119842359','fifties'],['010119850000','present'],['111120262359','present'],['111220260000','future'],['102120772200','future']])assert.equal(dateToEra(parseDate(input)),era);
});
test('datas Gregorianas sem normalização do Date',()=>{
  assert.throws(()=>parseDate('023119551200'));assert.throws(()=>parseDate('022919001200'));
  assert.equal(parseDate('022920001200').day,29);assert.equal(parseDate('010100011200').year,1);
  assert.throws(()=>parseDate('010100001200'));assert.throws(()=>parseDate('010120262400'));
  assert.ok(validateDate({month:1,day:1,year:NaN,hour:0,minute:0}));
});
test('digitação, correção e chegada preservam última partida',()=>{
  const now=parseDate('111120262204'),t=new TimeCircuits(now);t.begin();
  for(const key of '110519550601')t.type(key);t.type('Backspace');t.type('0');
  assert.equal(t.confirm().minute,0);t.arrive();assert.deepEqual(t.last,now);assert.equal(t.now.year,1955);assert.equal(t.destination,null);
});
