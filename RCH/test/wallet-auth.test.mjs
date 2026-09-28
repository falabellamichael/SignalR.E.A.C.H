import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Interface, hashMessage } from 'ethers';
import { verifyWallet } from '../service/server.mjs';

const owner = Wallet.createRandom();
const challenge = {wallet:owner.address,message:'REACH sign-in challenge for the expected origin and nonce'};
const delegatedCode = '0xef0100' + '12'.repeat(20);
const signatureInterface = new Interface(['function isValidSignature(bytes32,bytes) view returns (bytes4)']);

function providerFor(code, contractValid = false) {
  const calls = [];
  return {
    calls,
    getNetwork:async()=>({chainId:1n}),
    getCode:async()=>code,
    call:async request=>{
      calls.push(request);
      return signatureInterface.encodeFunctionResult('isValidSignature',[contractValid ? '0x1626ba7e' : '0xffffffff']);
    },
  };
}

test('delegated EOA signs in with its original key without ERC-1271 support',async()=>{
  const provider = providerFor(delegatedCode);
  assert.equal(await verifyWallet(challenge,await owner.signMessage(challenge.message),provider,1),true);
  assert.equal(provider.calls.length,0);
});

test('delegated EOA rejects another signer and altered messages',async()=>{
  const provider = providerFor(delegatedCode);
  assert.equal(await verifyWallet(challenge,await Wallet.createRandom().signMessage(challenge.message),provider,1),false);
  assert.equal(await verifyWallet({...challenge,message:'different sign-in'},await owner.signMessage(challenge.message),provider,1),false);
  assert.equal(provider.calls.length,2);
});

test('delegated EOA can still authorize an ERC-1271 contract signature',async()=>{
  const provider = providerFor(delegatedCode,true);
  assert.equal(await verifyWallet(challenge,'0x1234',provider,1),true);
  const [digest,signature] = signatureInterface.decodeFunctionData('isValidSignature',provider.calls[0].data);
  assert.equal(digest,hashMessage(challenge.message));
  assert.equal(signature,'0x1234');
});

test('ordinary contracts and malformed designations cannot bypass ERC-1271',async()=>{
  const signature = await owner.signMessage(challenge.message);
  for (const code of ['0x60006000','0xef0100'+'00'.repeat(20),delegatedCode+'00',delegatedCode.slice(0,-2)]) {
    const provider = providerFor(code);
    assert.equal(await verifyWallet(challenge,signature,provider,1),false,code);
    assert.equal(provider.calls.length,1);
  }
  assert.equal(await verifyWallet(challenge,signature,providerFor('0x'),1),true);
});

test('delegated authentication preserves chain and signature-format checks',async()=>{
  const provider = providerFor(delegatedCode);
  provider.getNetwork = async()=>({chainId:2n});
  await assert.rejects(verifyWallet(challenge,await owner.signMessage(challenge.message),provider,1),{code:'wrong_chain'});
  assert.equal(await verifyWallet(challenge,'invalid',provider,1),false);
  assert.equal(provider.calls.length,0);
});
