/** Attestations are minted only by the BNK-030 independent verification service; the ledger accepts no others. */
const minted=new WeakSet();
export const mintAttestation=record=>{const frozen=Object.freeze({...record,syntheticOnly:true});minted.add(frozen);return frozen;};
export const isMintedAttestation=value=>minted.has(value);
