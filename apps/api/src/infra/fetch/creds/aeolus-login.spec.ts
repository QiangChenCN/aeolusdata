import { encodeURIComponentLoose, rsaEncryptJs } from './aeolus-login.service';

/**
 * 风神 SSO 登录的**协议等价性**回归 —— 移植自 Python `aeolus_sdk/login.py`。
 *
 * 为什么必须钉住这两步：RSA 是复刻的 Dave Koelle 版 JS 库（**无填充分块**，不是标准
 * PKCS#1），URL 编码也不是 `encodeURIComponent` 的字面等价。任何一位算错，服务端只会回
 * 「账号或密码错误」—— 不会告诉你哪一位错了。下面每个向量都由 Python 原实现生成并
 * 逐字符比对（生成方式见 commit message）。
 */
describe('风神 SSO 协议移植等价性', () => {
  // Python: '_rsa_encrypt(_euc(s), M)'，M = 'c1ab' * 128（2048 bit）
  const M = 'c1ab'.repeat(128);

  it('encodeURIComponentLoose 与 Python _euc 逐字一致', () => {
    // 保留 !~*'()-._ 不编码；UTF-8 字节大写 hex 百分号编码
    expect(encodeURIComponentLoose('a b/c?d=中')).toBe('a%20b%2Fc%3Fd%3D%E4%B8%AD');
    expect(encodeURIComponentLoose("!~*'()-._")).toBe("!~*'()-._");
    expect(encodeURIComponentLoose('p@ss:w/rd#1+2')).toBe('p%40ss%3Aw%2Frd%231%2B2');
  });

  it('RSA 单块（明文 ≤ chunk）与 Python 一致', () => {
    expect(rsaEncryptJs(encodeURIComponentLoose('test123'), M)).toBe(
      '081df51b3439346a9ee99509166998955f69296875b7a759a6ffd49a96ce3de3' +
        'ea6787525ac62713886d3b2667a0102c4b0e4feec8cc0242a19edaacaa26cd7f' +
        '5d963a66b18b15984d5544490dafac0e36e5b84d5c2c1f600d1ed4be4bce95b3' +
        'cf9c05fea743fa1c2fe04bf2890244c6f3f7ceaef70b36141f1efad7520d266e' +
        '708c4c2d1e69f0b256e07209b87bdb9e03c48b612e427bf7f9e6c9ecf5b3b01' +
        '149ebc2094b2be217e051151125659cbb77ce2774e4a0a3ddb625c1f50d94414' +
        '7dd7403c5d8194e2517a8d8fab0e03ef526943e4daac4fb064bc537e148cb14' +
        '12cf2ef7e7ed56da4f04bc6c8dfb8f548b1ea1e365477fa24fc81cca243b22b932',
    );
    expect(rsaEncryptJs(encodeURIComponentLoose('e2e@x.com'), M)).toBe(
      'c06fdf55ca6122fbfee96ceaf9ffdf7253cabdb6172ae6c02a5ea52d9ce46f51' +
        '3cd72e7c0b848a24b25a04108029a0976718dc0e743149683d476d0f7c0beee6' +
        'a72bc17eec9efef1ff7e2674fd1c3750c0b890386847d88534b01caaa13d1ff7' +
        'ee0c7d60fac7fb21be7409627b0b70f38713f6cc0a274b16580a97f959aabcdd' +
        'd140d4fc0eab9b15a2fa5e0037c29e25538a4f4e6311856aeacf6fb949035e32' +
        '11eb16a25d1185b19cdad4bf9edef8b0518a5db77b2cf5c1a2f7668ad000b422' +
        'baba3245030f356e0c2567115c41177a08514d929e6d70eb68254ba3e1becfd4' +
        '5a6c23c09e50f02a1be9157006c8e17acba5ab1c9cc4d6f89450748cb4b7cef5',
    );
  });

  it('RSA 多字节 UTF-8（中文密码）与 Python 一致', () => {
    expect(rsaEncryptJs(encodeURIComponentLoose('中'.repeat(5)), M)).toBe(
      '4c08c7722a204a14f3190e840ca6b928038b4238554e9782f172ec7b92b60544' +
        '03182eaadea58d5d015ac111ba5273a0f5d8e83e7593e58ff0167801875ff138' +
        '4e2a5574c904eaf591eba468eccc9c348e2545aa2fc218a26a0cd00daf20cc3f' +
        '7fc6b871c0cbd6e25ea5094fa870c7b8c9893d19423666829253d7ea15492a266' +
        '57be6bd5ec310149bce60c8b8011b660bcd2bdce72e3efb5f4d0d4e428bed453' +
        '0ad4a6ce9b03a91e28dfa93967187b5521435f8b9820b04fd72e841b2987eac3' +
        'aa4144fa09f909a351df83d8ba49efe46a5926a3f2fcd49173c9f31b8934e03b' +
        'ce74100e20c8a684ea91f775cf78c3275c52fa3a9df2dcb975116da6ca1641f',
    );
  });

  it('RSA 跨块（明文 300 字节 → 2 块）与 Python 一致', () => {
    const hex = rsaEncryptJs(encodeURIComponentLoose('a'.repeat(300)), M);
    // 2 块 × 512 hex = 1024
    expect(hex).toHaveLength(1024);
    expect(hex).toBe(
      '843adddcf85cf8050623f696736f658eb09d2e6b95d1bbaf8d2d29698cfe801a' +
        'fd5ead279bfd3fd3445e39589cb32a7161d72dc6e3ce7779d4e28c6ec6199f3f' +
        '0dcf5992f472a9cd4fff8f9cf5ced8a552eefef24fd0ffe6aaf222258c3afcb9' +
        'eff70faae4ea6bf069077acf88774c1c54225450ce0b17dd4e9bce067c1bffbc' +
        '689a9b47a81b3c69ec58294c701785e9e3429a760e3bfb7e7b11b9e7b3d0486' +
        '24e4d5f024ccdbf0d98a0c0d7c5931fbc150f81ae019d907059a7a0c8ffbc665' +
        '9c13275469a378b23d2883a960c4c6754649d7e2f4ebfdad2f6694940e62d46f' +
        'f875b6b2e55b37c409146c02cad826595626361a9dd6f9eb77a3a5791a1e40c6' +
        '683827abf078b37cfed59a2f6a576f18a7d7f09a2923ed2e93e4015984be4e9d' +
        'ddd24a3bd33b36ae4cdbea5d5407a702bc5b54ca772eafa23e44b6ddeb564e189' +
        '2e900bb10b57c7616fe9b5791fae440f22d76761fd626633c3c5b7537ed2858c8' +
        'e06766cb751bbce5b8f0bb7dbc7ba2b55eb6bf4b2c05ae8357def88a4e8ccbec0' +
        '873f57b5ad4255226f150f7acceca32c5496eb7e55b92de0970a8c786fbc1725' +
        'a41b07ee1424778d1d24ba6b2af10e715a45e0aa8a5381ad9bb491c465bf7c85' +
        'e7ebda5c1b5595b73b8e68c2a70bc21808f42cd02324953a99cd03bec22d8bf6' +
        '1432e88766ca550a9f62203d0a287e30f590791cf05f29db130060579d36ea',
    );
  });

  it('RSA 空明文返回空串（不产生块）', () => {
    expect(rsaEncryptJs('', M)).toBe('');
  });

  describe('生产密钥尺寸（1024 位；真实 rsaPublicKey 就是 256 hex）', () => {
    // 单块上限随密钥尺寸变化（1024 位 → chunk=126 字节），必须按真实尺寸再验一遍
    const M1024 = 'b4'.repeat(128);

    it('单块与 Python 一致', () => {
      expect(rsaEncryptJs(encodeURIComponentLoose('test123'), M1024)).toBe(
        '280df0ac0206d480a52db6767e4923971291642d535dd2b5504a4deb3be59d58' +
          'e3b6f8bf5555b88f1821ff9b3c695c4b724026c75cd0558407284c05671ebe2a' +
          'ea6ded90390813211461cca76df39a670cdda5feb654c9ca0847bc0343fd592a' +
          '4e2ead4a43fe83cee40067e433f548b5c1fd6177edee87c7969f745f3c938f04',
      );
    });

    it('跨块（明文 200 字节 → 2 块）与 Python 一致', () => {
      const hex = rsaEncryptJs(encodeURIComponentLoose('x'.repeat(200)), M1024);
      expect(hex).toHaveLength(512);
      expect(hex).toBe(
        '548fdb3366984af56c754acde85a88e0240d6c851970c1051e1bc443f4497ffd' +
          '075bbb7378c2e11d9aa6194cc95dca531a84833e3e45f92301981141dae70f99' +
          'd4fed94030b9a36e85c4cf1006701adb78bb27a582f3dbb8b3fc5f594bf6a227' +
          '544fc6ee2e3301d041d1659bd40bf95d1f117507c96b3ee8312c09d6cea825f8' +
          '723376399fe506e967f6b90c74850624ae9a7726cff6b4265693312d97f8b97c' +
          '45d165bc5e6c6d43560b6de4191f2d5047a21bbc973a69451557d34ece1f1e9f' +
          '0cccd49d59046ac3a82a7aa5239ba094159a6eeda880976e2141c62b6779c333' +
          'ccabaf6b5b625fff7b9bca701a8f317c0ada558907c5adac02ce6e4cebe74344',
      );
    });
  });
});
