// @flow
var bs58check = require('bs58check')
var zcrypto = require('./crypto')
var zutils = require('./utils')
var secp256k1 = require('secp256k1')

/* Useful OP codes for the scripting language
 * Obtained from: https://github.com/ZencashOfficial/zen/blob/master/src/script/script.h
 */
const OP_DUP = '76'
const OP_HASH160 = 'a9'
const OP_EQUALVERIFY = '88'
const OP_CHECKSIG = 'ac'
const OP_CHECKBLOCKATHEIGHT = 'b4'
const OP_EQUAL = '87'
const OP_REVERSED = '89'

/* SIGHASH Codes
 * Obtained from: https://github.com/ZencashOfficial/zen/blob/master/src/script/interpreter.h
 */
const SIGHASH_ALL = 1
const SIGHASH_NONE = 2
const SIGHASH_SINGLE = 3
const SIGHASH_ANYONECANPAY = 0x80

/*
 * Object types
 */
// TXOBJ Structure
declare type TXOBJ = {
  locktime: number,
  version: number,
  ins: {
    output: { hash: string, vout: number },
    script: string,
    sequence: string,
  }[],
  outs: { script: string, satoshis: number }[],
}

// HISTORY Structure
declare type HISTORY = {
  txid: string,
  vout: number,
  value: number,
  address: string,
}

// RECIPIENTS Structure
declare type RECIPIENTS = {
  satoshis: number,
  address: string,
}

// https://github.com/bitcoinjs/bitcoinjs-lib/issues/14
function numToBytes (num: number, bytes: number) {
  if (bytes == 0) return []
  else return [num % 256].concat(numToBytes(Math.floor(num / 256), bytes - 1))
}
function numToVarInt (num: number): string {
  var b
  if (num < 253) b = [num]
  else if (num < 65536) b = [253].concat(numToBytes(num, 2))
  else if (num < 4294967296) b = [254].concat(numToBytes(num, 4))
  else b = [253].concat(numToBytes(num, 8))
  return Buffer(b).toString('hex')
}

/*
 * Given a hex string, get the length of it in bytes
 * ** NOT string.length, but convert it into bytes
 *    and return the length of that in bytes in hex
 * @param {String} hexStr
 * return {String} Length of hexStr in bytes
 */
function getStringBufferLength (hexStr: string): string {
  const _tmpBuf = Buffer.from(hexStr, 'hex').length
  return Buffer.from([_tmpBuf]).toString('hex')
}

/* More info: https://github.com/ZencashOfficial/zen/blob/master/src/script/standard.cpp#L377
 * Given an address, generates a pubkeyhash type script needed for the transaction
 * @param {String} address
 * return {String} pubKeyScript
 */
function mkPubkeyHashReplayScript (address: string): string {
  var addrHex = bs58check.decode(address).toString('hex')

  // Cut out the first 4 bytes (pubKeyHash)
  var subAddrHex = addrHex.substring(4, addrHex.length)

  // TODO: change this so it gets block hash and height via REST API
  var blockHeight = 141575

  var blockHeightBuffer = Buffer.alloc(4)
  blockHeightBuffer.writeUInt32LE(blockHeight, 0)
  if (blockHeightBuffer[3] === 0x00) {
    var temp_buf = new Buffer(3)
    temp_buf.fill(blockHeightBuffer, 0, 3)
    blockHeightBuffer = temp_buf
  }
  var blockHeightHex = blockHeightBuffer.toString('hex')
  var blockHeightLength = getStringBufferLength(blockHeightHex)

  // Need to reverse it
  var blockHash =
    '00000004bbe8504b7a8e7c6e23ea6fa57878ce946f9819752405d964175c4276'
  var blockHashHex = Buffer.from(blockHash, 'hex').reverse().toString('hex')
  var blockHashLength = getStringBufferLength(blockHashHex)

  // '14' is the length of the subAddrHex (in bytes)
  return (
    OP_DUP +
    OP_HASH160 +
    getStringBufferLength(subAddrHex) +
    subAddrHex +
    OP_EQUALVERIFY +
    OP_CHECKSIG +
    blockHashLength +
    blockHashHex +
    blockHeightLength +
    blockHeightHex +
    OP_CHECKBLOCKATHEIGHT
  )
}

/*
 * Given an address, generates a script hash type script needed for the transaction
 * @param {String} address
 * return {String} scriptHash script
 */
function mkScriptHashScript (address: string): string {
  var addrHex = bs58check.decode(address).toString('hex')
  var subAddrHex = addrHex.substring(4, addrHex.length) // Cut out the '00' (we also only want 14 bytes instead of 16)
  // '14' is the length of the subAddrHex (in bytes)
  return OP_HASH160 + '14' + subAddrHex + OP_EQUAL
}

/*
 * Given an address, generates an output script
 * @param {String} address
 * return {String} output script
 */
function addressToScript (address: string): string {
  // P2SH starts with a 3 or 2
  if (address[0] === '3' || address[0] === '2') {
    return mkScriptHashScript(address)
  }

  // P2PKH-replay is a replacement for P2PKH
  // P2PKH-replay starts with a 0
  return mkPubkeyHashReplayScript(address)
}

/*
 * Signature hashing for TXOBJ
 * @param {String} address
 * return {String} output script
 */
function signatureForm (
  txObj: TXOBJ,
  i: number,
  script: string,
  hashcode: number
): TXOBJ {
  // Copy object so we don't rewrite it
  var newTx = Object.assign({}, txObj)

  for (var j = 0; j < newTx.ins.length; j++) {
    newTx.ins[j].script = ''
  }
  newTx.ins[i].script = script

  if (hashcode === SIGHASH_NONE) {
    newTx.outs = []
  } else if (hashcode === SIGHASH_SINGLE) {
    newTx.outs = newTx.outs.slice(0, newTx.ins.length)
    for (var j = 0; j < newTx.ins.length - 1; ++j) {
      newTx.outs[j].satoshis = Math.pow(2, 64) - 1
      newTx.outs[j].script = ''
    }
  } else if (hashcode === SIGHASH_ANYONECANPAY) {
    newTx.ins = [newTx.ins[i]]
  }

  return newTx
}

/*
 * Serializes a TXOBJ into hex string
 * @param {Object} txObj
 * return {String} output script
 */
function serializeTx (txObj: TXOBJ): string {
  var serializedTx = ''
  var _buf16 = Buffer.alloc(4)

  // Version
  _buf16.writeUInt16LE(txObj.version, 0)
  serializedTx += _buf16.toString('hex')

  // History
  serializedTx += numToVarInt(txObj.ins.length)
  txObj.ins.map(function (i) {
    // Txids and vouts
    _buf16.writeUInt16LE(i.output.vout, 0)
    serializedTx += i.output.hash
    serializedTx += _buf16.toString('hex')

    // Script
    serializedTx += numToVarInt(i.script.length)
    serializedTx += i.script

    // Sequence
    serializedTx += i.sequence
  })

  // Outputs
  serializedTx += numToVarInt(txObj.outs.length)
  txObj.outs.map(function (o) {
    // ffffffffffffffffffff
    // Some hack I'm using to do SIGHASH_SINGLE
    var _buf32 = Buffer.alloc(8)

    if (o.satoshis === Math.pow(2, 64) - 1) {
      _buf32.writeUInt32LE(Math.pow(2, 32) - 1, 0)
      _buf32.writeUInt32LE(Math.pow(2, 32) - 1, 4)
    } else {
      _buf32.writeUInt32LE(o.satoshis, 0)
    }

    serializedTx += _buf32.toString('hex')
    serializedTx += numToVarInt(o.script.length)
    serializedTx += o.script
  })

  // Locktime
  _buf16.writeUInt16LE(txObj.locktime, 0)
  serializedTx += _buf16.toString('hex')

  return serializedTx
}

/*
 * Creates a raw transaction
 * @param {[object]} history, array of history in the format: [{txid: 'transaction_id', vout: vout, value: value (insatoshi), address: txout address}]
 * @param {[object]} output address on where to send coins to [{value}]
 * @param {Int} Amount of zencash to send (in satoshis)
 * @return {TXOBJ} Transction Object (see types.js for info about structure)
 */
function createRawTx (history: HISTORY[], recipients: RECIPIENTS[]): TXOBJ {
  var txObj = { locktime: 0, version: 1, ins: [], outs: [] }

  txObj.ins = history.map(function (h) {
    return {
      output: { hash: h.txid, vout: h.vout },
      script: '',
      sequence: 'ffffffff'
    }
  })
  txObj.outs = recipients.map(function (o) {
    return { script: addressToScript(o.address), satoshis: o.satoshis }
  })

  return txObj
}

/*
 * Signs the raw transaction
 * @param {String} rawTx raw transaction
 * @param {Int} i
 * @param {privKey} privKey (not WIF format)
 * @param {hashcode} hashcode
 * return {String} signed transaction
 */
function signTx (
  txObj: TXOBJ,
  i: number,
  privKey: string,
  hashcode: number
): TXOBJ {
  if (hashcode === undefined) {
    hashcode = SIGHASH_ALL
  }

  // Buffer
  var _buf16 = Buffer.alloc(4)
  _buf16.writeUInt16LE(hashcode)

  // Prepare signing
  const pubKey = zutils.privKeyToPubKey(privKey)
  const address = zutils.pubKeyToAddr(pubKey)
  const script = mkPubkeyHashReplayScript(address)

  // Prepare our signature
  const signingTx: TXOBJ = signatureForm(txObj, i, script, hashcode)
  const signingTxHex: string = serializeTx(signingTx) // Convert to hex string

  // Get message from signature (sha256 twice)
  const signingTxWithHashcode: Buffer = Buffer.concat([
    Buffer.from(signingTxHex, 'hex'),
    _buf16
  ])
  const msg = zcrypto.sha256x2(signingTxWithHashcode)
  const rawsig = secp256k1
    .sign(Buffer.from(msg, 'hex'), Buffer.from(privKey, 'hex'))
    .signature.toString('hex')

  // Encode signature
  var b1 = rawsig.substr(0, 64)
  var b2 = rawsig.substr(64, 128)

  if ('89abcdef'.indexOf(b1[0]) != -1) {
    b1 = '00' + b1
  }
  if ('89abcdef'.indexOf(b2[0]) != -1) {
    b2 = '00' + b2
  }

  var left = '02' + getStringBufferLength(b1) + b1
  var right = '02' + getStringBufferLength(b2) + b2  
  const sig = '30' + getStringBufferLength(left + right) + left + right
  const sigAndHashcode = sig + Buffer.from([hashcode], 'hex').toString('hex')

  // Chuck it back into txObj
  txObj.ins[i].script =
    getStringBufferLength(sigAndHashcode) + sigAndHashcode + getStringBufferLength(pubKey) + pubKey

  return txObj
}

module.exports = {
  addressToScript: addressToScript,
  createRawTx: createRawTx,
  getStringBufferLength: getStringBufferLength,
  mkPubkeyHashReplayScript: mkPubkeyHashReplayScript,
  mkScriptHashScript: mkScriptHashScript,
  numToVarInt: numToVarInt,
  signatureForm: signatureForm,
  serializeTx: serializeTx,
  signTx: signTx
}