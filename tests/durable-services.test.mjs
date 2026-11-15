import test from 'node:test';
import {MemoryEngineStore} from '../src/runtime/memory-store.mjs';
import {storeContract} from './support/store-contract.mjs';

storeContract(test,'memory store',async()=>new MemoryEngineStore());
