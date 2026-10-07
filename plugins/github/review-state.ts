import type {EventRecord} from '../../src/host/schema.ts';
/** Old releases appended duplicate begins. Fold only contiguous immutable
 * duplicates; a changed target/revision starts a new evidence scope. */
export function currentReviewBegin(events:readonly EventRecord[]):EventRecord|undefined{
 const begins=events.filter(e=>e.name==='review/begin');let current=begins.at(-1);
 const selection=events.filter(e=>e.name==='review/selection').at(-1);
 if(selection&&selection.seq>(current?.seq??0)){const selected=begins.find(e=>e.seq===selection.payload.begin_seq);if(selected)current=selected;}
 if(!current)return undefined;
 const key=(e:EventRecord)=>JSON.stringify([e.payload.target,e.payload.number,e.payload.head,e.payload.base,e.payload.merge_base,e.payload.files]);
 const signature=key(current);
 for(let i=begins.findIndex(e=>e.seq===current!.seq)-1;i>=0;i--){const prior=begins[i]!;if(key(prior)!==signature)break;current=prior;}
 return current;
}
