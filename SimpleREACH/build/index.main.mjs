// Automatically generated with Reach 0.1.13
/* eslint-disable */
export const _version = '0.1.13';
export const _versionHash = '0.1.13';
export const _backendVersion = 27;

export function getExports(s) {
  const stdlib = s.reachStdlib;
  return {
    };
  };
export function _getEvents(s) {
  const stdlib = s.reachStdlib;
  return {
    };
  };
export function _getViews(s, viewlib) {
  const stdlib = s.reachStdlib;
  
  return {
    infos: {
      },
    views: {
      1: []
      }
    };
  
  };
export function _getMaps(s) {
  const stdlib = s.reachStdlib;
  const ctc0 = stdlib.T_Tuple([]);
  return {
    mapDataTy: ctc0
    };
  };
export async function Alice(ctcTop, interact) {
  if (typeof(ctcTop) !== 'object' || ctcTop._initialize === undefined) {
    return Promise.reject(new Error(`The backend for Alice expects to receive a contract as its first argument.`));}
  if (typeof(interact) !== 'object') {
    return Promise.reject(new Error(`The backend for Alice expects to receive an interact object as its second argument.`));}
  const ctc = ctcTop._initialize();
  const stdlib = ctc.stdlib;
  
  
  const txn1 = await (ctc.sendrecv({
    args: [],
    evt_cnt: 0,
    funcNum: 0,
    lct: stdlib.checkedBigNumberify('./SimpleREACH/index.rsh:12:5:dot', stdlib.UInt_max, '0'),
    onlyIf: true,
    out_tys: [],
    pay: [stdlib.checkedBigNumberify('./SimpleREACH/index.rsh:12:5:decimal', stdlib.UInt_max, '0'), []],
    sim_p: (async (txn1) => {
      const sim_r = { txns: [], mapRefs: [], maps: [] };
      let sim_txn_ctr = stdlib.UInt_max;
      const getSimTokCtr = () => { sim_txn_ctr = sim_txn_ctr.sub(1); return sim_txn_ctr; };
      
      
      const {data: [], secs: v39, time: v38, didSend: v22, from: v37 } = txn1;
      
      ;
      sim_r.isHalt = false;
      
      return sim_r;
      }),
    soloSend: true,
    timeoutAt: undefined /* mto */,
    tys: [],
    waitIfNotPresent: false
    }));
  const {data: [], secs: v39, time: v38, didSend: v22, from: v37 } = txn1;
  ;
  const txn2 = await (ctc.recv({
    didSend: false,
    evt_cnt: 0,
    funcNum: 1,
    out_tys: [],
    timeoutAt: undefined /* mto */,
    waitIfNotPresent: false
    }));
  const {data: [], secs: v42, time: v41, didSend: v26, from: v40 } = txn2;
  ;
  return;
  
  
  
  
  };
export async function Bob(ctcTop, interact) {
  if (typeof(ctcTop) !== 'object' || ctcTop._initialize === undefined) {
    return Promise.reject(new Error(`The backend for Bob expects to receive a contract as its first argument.`));}
  if (typeof(interact) !== 'object') {
    return Promise.reject(new Error(`The backend for Bob expects to receive an interact object as its second argument.`));}
  const ctc = ctcTop._initialize();
  const stdlib = ctc.stdlib;
  
  
  const txn1 = await (ctc.recv({
    didSend: false,
    evt_cnt: 0,
    funcNum: 0,
    out_tys: [],
    timeoutAt: undefined /* mto */,
    waitIfNotPresent: false
    }));
  const {data: [], secs: v39, time: v38, didSend: v22, from: v37 } = txn1;
  ;
  const txn2 = await (ctc.sendrecv({
    args: [],
    evt_cnt: 0,
    funcNum: 1,
    lct: v38,
    onlyIf: true,
    out_tys: [],
    pay: [stdlib.checkedBigNumberify('./SimpleREACH/index.rsh:15:5:decimal', stdlib.UInt_max, '0'), []],
    sim_p: (async (txn2) => {
      const sim_r = { txns: [], mapRefs: [], maps: [] };
      let sim_txn_ctr = stdlib.UInt_max;
      const getSimTokCtr = () => { sim_txn_ctr = sim_txn_ctr.sub(1); return sim_txn_ctr; };
      
      
      const {data: [], secs: v42, time: v41, didSend: v26, from: v40 } = txn2;
      
      ;
      sim_r.txns.push({
        kind: 'halt',
        tok: undefined /* Nothing */
        })
      sim_r.isHalt = true;
      
      return sim_r;
      }),
    soloSend: true,
    timeoutAt: undefined /* mto */,
    tys: [],
    waitIfNotPresent: false
    }));
  const {data: [], secs: v42, time: v41, didSend: v26, from: v40 } = txn2;
  ;
  return;
  
  
  
  
  };
const _ALGO = {
  ABI: {
    impure: [`_reachp_0((uint64))void`, `_reachp_1((uint64))void`],
    pure: [],
    sigs: [`_reachp_0((uint64))void`, `_reachp_1((uint64))void`]
    },
  GlobalNumByteSlice: 1,
  GlobalNumUint: 0,
  LocalNumByteSlice: 0,
  LocalNumUint: 0,
  appApproval: `CCACAAEmAQAxGEEAsChkSSJbNQGBCFs1AiiCAgTBlK2ZBN/ZIyg2GgCOAgBvAIMANAsXNQyABILEYf40DBZQsDQMiADqKCMyBjUCNQFIKDQBFjQCFlBnMRkiEkSIAMQ0A0AACoAEFR98dTQEULAjQyM0ARJENAsXNQyABNUVGRQ0DBZQsDQMiAClMRmBBRJEiACQIjIKMgmIAKJC/8GIAH6BoI0GNAYINQY2GgE1C0L/fogAajYaATULQv+zIjE0EkQjMTUSRCIxNhJEIjE3EkSIAEsoIiJC/28xGSISREL/giKyASOyELIHsgiziUiJTAlJNQYyCYgAP4kJSUH/7kk1BjEWNAAjCEk1AAlHAjgHMgoSRDgQIxJEOAgSRIkjNQOJNAY0B0oPQf/EQv/MSSISTDQCEhFEibFC/6WxsglC/58=`,
  appApprovalMap: {
    0: `2`,
    1: `2`,
    10: `5`,
    100: `59`,
    101: `59`,
    102: `59`,
    103: `59`,
    104: `59`,
    105: `59`,
    106: `60`,
    107: `60`,
    108: `61`,
    109: `62`,
    11: `5`,
    110: `64`,
    111: `65`,
    112: `67`,
    113: `68`,
    114: `68`,
    115: `69`,
    116: `70`,
    117: `72`,
    118: `72`,
    119: `73`,
    12: `5`,
    120: `74`,
    121: `74`,
    122: `75`,
    123: `75`,
    124: `75`,
    125: `75`,
    126: `75`,
    127: `75`,
    128: `76`,
    129: `76`,
    13: `6`,
    130: `77`,
    131: `78`,
    132: `79`,
    133: `81`,
    134: `81`,
    135: `82`,
    136: `82`,
    137: `82`,
    138: `84`,
    139: `84`,
    14: `7`,
    140: `85`,
    141: `85`,
    142: `86`,
    143: `87`,
    144: `89`,
    145: `89`,
    146: `89`,
    147: `91`,
    148: `92`,
    149: `92`,
    15: `8`,
    150: `93`,
    151: `93`,
    152: `94`,
    153: `94`,
    154: `94`,
    155: `95`,
    156: `95`,
    157: `95`,
    158: `97`,
    159: `97`,
    16: `9`,
    160: `97`,
    161: `98`,
    162: `98`,
    163: `98`,
    164: `98`,
    165: `100`,
    166: `100`,
    167: `101`,
    168: `102`,
    169: `102`,
    17: `10`,
    170: `103`,
    171: `103`,
    172: `103`,
    173: `104`,
    174: `104`,
    175: `105`,
    176: `105`,
    177: `105`,
    178: `107`,
    179: `107`,
    18: `11`,
    180: `107`,
    181: `108`,
    182: `108`,
    183: `108`,
    184: `109`,
    185: `109`,
    186: `110`,
    187: `110`,
    188: `110`,
    189: `112`,
    19: `11`,
    190: `113`,
    191: `113`,
    192: `114`,
    193: `115`,
    194: `116`,
    195: `117`,
    196: `117`,
    197: `118`,
    198: `119`,
    199: `120`,
    2: `2`,
    20: `12`,
    200: `121`,
    201: `121`,
    202: `122`,
    203: `123`,
    204: `124`,
    205: `125`,
    206: `125`,
    207: `126`,
    208: `127`,
    209: `128`,
    21: `12`,
    210: `128`,
    211: `128`,
    212: `129`,
    213: `130`,
    214: `131`,
    215: `132`,
    216: `132`,
    217: `132`,
    218: `134`,
    219: `134`,
    22: `13`,
    220: `135`,
    221: `136`,
    222: `137`,
    223: `139`,
    224: `139`,
    225: `139`,
    226: `141`,
    227: `142`,
    228: `142`,
    229: `143`,
    23: `14`,
    230: `144`,
    231: `144`,
    232: `145`,
    233: `145`,
    234: `146`,
    235: `146`,
    236: `147`,
    237: `148`,
    238: `150`,
    239: `151`,
    24: `14`,
    240: `153`,
    241: `154`,
    242: `155`,
    243: `156`,
    244: `156`,
    245: `157`,
    246: `157`,
    247: `158`,
    248: `158`,
    249: `158`,
    25: `15`,
    250: `159`,
    251: `161`,
    252: `162`,
    253: `163`,
    254: `163`,
    255: `163`,
    256: `164`,
    257: `165`,
    258: `165`,
    259: `168`,
    26: `17`,
    260: `168`,
    261: `169`,
    262: `169`,
    263: `170`,
    264: `171`,
    265: `172`,
    266: `173`,
    267: `173`,
    268: `174`,
    269: `175`,
    27: `17`,
    270: `175`,
    271: `176`,
    272: `176`,
    273: `177`,
    274: `177`,
    275: `178`,
    276: `179`,
    277: `180`,
    278: `180`,
    279: `181`,
    28: `17`,
    280: `182`,
    281: `183`,
    282: `184`,
    283: `184`,
    284: `185`,
    285: `186`,
    286: `187`,
    287: `189`,
    288: `190`,
    289: `190`,
    29: `17`,
    290: `191`,
    291: `193`,
    292: `193`,
    293: `194`,
    294: `194`,
    295: `195`,
    296: `196`,
    297: `197`,
    298: `197`,
    299: `197`,
    3: `2`,
    30: `17`,
    300: `198`,
    301: `198`,
    302: `198`,
    303: `200`,
    304: `201`,
    305: `202`,
    306: `203`,
    307: `204`,
    308: `204`,
    309: `205`,
    31: `17`,
    310: `206`,
    311: `207`,
    312: `208`,
    313: `210`,
    314: `211`,
    315: `211`,
    316: `211`,
    317: `213`,
    318: `214`,
    319: `214`,
    32: `17`,
    320: `215`,
    33: `17`,
    34: `17`,
    35: `17`,
    36: `17`,
    37: `17`,
    38: `18`,
    39: `18`,
    4: `2`,
    40: `18`,
    41: `19`,
    42: `19`,
    43: `19`,
    44: `19`,
    45: `19`,
    46: `19`,
    47: `21`,
    48: `23`,
    49: `23`,
    5: `2`,
    50: `24`,
    51: `25`,
    52: `25`,
    53: `26`,
    54: `26`,
    55: `26`,
    56: `26`,
    57: `26`,
    58: `26`,
    59: `27`,
    6: `2`,
    60: `27`,
    61: `28`,
    62: `29`,
    63: `30`,
    64: `32`,
    65: `32`,
    66: `33`,
    67: `33`,
    68: `33`,
    69: `35`,
    7: `2`,
    70: `36`,
    71: `37`,
    72: `37`,
    73: `39`,
    74: `39`,
    75: `40`,
    76: `40`,
    77: `41`,
    78: `42`,
    79: `43`,
    8: `4`,
    80: `43`,
    81: `44`,
    82: `45`,
    83: `45`,
    84: `46`,
    85: `47`,
    86: `48`,
    87: `49`,
    88: `49`,
    89: `50`,
    9: `4`,
    90: `51`,
    91: `52`,
    92: `54`,
    93: `54`,
    94: `54`,
    95: `56`,
    96: `56`,
    97: `57`,
    98: `57`,
    99: `57`
    },
  appClear: `CA==`,
  appClearMap: {
    },
  companionInfo: null,
  extraPages: 0,
  stateKeys: 0,
  stateSize: 0,
  unsupported: [],
  version: 13,
  warnings: []
  };
const _ETH = {
  ABI: `[{"inputs":[{"components":[{"internalType":"uint256","name":"elem0","type":"uint256"}],"internalType":"struct T0","name":"v71","type":"tuple"}],"stateMutability":"payable","type":"constructor"},{"inputs":[{"internalType":"uint256","name":"msg","type":"uint256"}],"name":"ReachError","type":"error"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"_who","type":"address"},{"components":[{"internalType":"uint256","name":"elem0","type":"uint256"}],"indexed":false,"internalType":"struct T0","name":"_a","type":"tuple"}],"name":"_reach_e0","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"_who","type":"address"},{"components":[{"internalType":"uint256","name":"elem0","type":"uint256"}],"indexed":false,"internalType":"struct T0","name":"_a","type":"tuple"}],"name":"_reach_e1","type":"event"},{"stateMutability":"payable","type":"fallback"},{"inputs":[],"name":"_reachCreationTime","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"_reachCurrentState","outputs":[{"internalType":"uint256","name":"","type":"uint256"},{"internalType":"bytes","name":"","type":"bytes"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"_reachCurrentTime","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"components":[{"internalType":"uint256","name":"elem0","type":"uint256"}],"internalType":"struct T0","name":"v74","type":"tuple"}],"name":"_reachp_1","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"payable","type":"function"},{"stateMutability":"payable","type":"receive"}]`,
  Bytecode: `0x608061068590813803601f1980601f83011683019360018060401b03928486108487111761028b57808592604097885283396020948591810103126102865784519061004a826102a1565b51815243600355845161005c816102a1565b600080915260049160ff83541661026f577f87b51d26f290dc1fb530aed45f92ac77d813efb7cccb67b06c40d875955dde87878051338152835189820152a1518015908115610263575b501561024c573461023557600194858255438655865192828285015281845287840184811087821117610222578852835195861161020f57600254908782811c92168015610205575b838310146101f25750601f81116101ab575b508093601f86116001146101485750509183949184939461013d575b50501b916000199060031b1c1916176002555b516103c890816102bd8239f35b01519250388061011d565b600283528183209493928692918316915b888383106101915750505010610178575b505050811b01600255610130565b015160001960f88460031b161c1916905538808061016a565b858701518855909601959485019487935090810190610159565b60028352818320601f870160051c8101918388106101e8575b601f0160051c019087905b8281106101dd575050610101565b8481550187906101cf565b90915081906101c4565b634e487b7160e01b845260229052602483fd5b91607f16916100ef565b634e487b7160e01b835260419052602482fd5b634e487b7160e01b845260418252602484fd5b855163100960cb60e01b8152600981840152602490fd5b855163100960cb60e01b8152600881840152602490fd5b905060015414386100a6565b865163100960cb60e01b8152600781850152602490fd5b600080fd5b634e487b7160e01b600052604160045260246000fd5b602081019081106001600160401b0382111761028b5760405256fe608060408181526004918236101561001f575b505050361561001d57005b005b600092833560e01c9182631e93b0f11461026d57508163573b8510146100e75750806383230757146100c95763ab53f2c61461005b5780610012565b346100c557816003193601126100c55781546100756102f4565b91805193849283526020828185015284518093850152815b8381106100ae57505060608094508284010152601f80199101168101030190f35b80860182015187820160600152869450810161008d565b5080fd5b50346100c557816003193601126100c5576020906001549051908152f35b83836020928360031936011261026957828251610103816102c3565b52815190610110826102c3565b8035825260019182855403610252576101276102f4565b868180518101031261024e578601518015150361024a5760ff825416610233577fcf0e8bec53cd91fa87ecf8f6f405ac75914a22acdb92a3553ee5c294fee81596848051338152835189820152a1518015908115610228575b501561021157346101fa575082805582815561019d600254610289565b806101ab575b505051908152f35b601f81116001146101c4575050816002555b83806101a3565b6002845281601f868620920160051c820191015b8181106101f0575050508183812081600255556101bd565b84815582016101d8565b602490600d84519163100960cb60e01b8352820152fd5b602490600c84519163100960cb60e01b8352820152fd5b905082541486610180565b835163100960cb60e01b8152600b81840152602490fd5b8480fd5b8580fd5b835163100960cb60e01b8152600a81840152602490fd5b8280fd5b8490346100c557816003193601126100c5576020906003548152f35b90600182811c921680156102b9575b60208310146102a357565b634e487b7160e01b600052602260045260246000fd5b91607f1691610298565b602081019081106001600160401b038211176102de57604052565b634e487b7160e01b600052604160045260246000fd5b60405190600060025461030681610289565b80855260019180831690811561039c5750600114610344575b5050829003601f01601f191682016001600160401b038111838210176102de57604052565b600260009081526020935091837f405787fa12a823e0f2b7631cc41b3ba8828b3321ca811111fa75cd3aa3bb5ace5b8385106103885750505050830101388061031f565b805488860183015293019284908201610373565b919250506020925060ff191682850152151560051b830101388061031f56fea164736f6c6343000811000a`,
  BytecodeLen: 1669,
  version: 9,
  views: {
    }
  };
export const _stateSourceMap = {
  1: {
    at: './SimpleREACH/index.rsh:13:11:after expr stmt semicolon',
    fs: [],
    msg: null,
    who: 'Module'
    },
  2: {
    at: './SimpleREACH/index.rsh:16:11:after expr stmt semicolon',
    fs: [],
    msg: null,
    who: 'Module'
    }
  };
export const _Connectors = {
  ALGO: _ALGO,
  ETH: _ETH
  };
export const _Participants = {
  "Alice": Alice,
  "Bob": Bob
  };
export const _APIs = {
  };
