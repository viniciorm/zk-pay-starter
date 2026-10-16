pragma circom 2.1.9;

include "../lib/poseidon_classic.circom";

/// Public: root, nullifierHash, recipient, fee.
/// Private: nullifier, secret, pathElements[8], pathIndices[8].
template HashLeftRight() {
    signal input left;
    signal input right;
    signal input sel;
    signal output out;

    // sel is 0 or 1
    sel * (1 - sel) === 0;

    signal a <== left + sel * (right - left);
    signal b <== right + sel * (left - right);

    component h = Hash2();
    h.a <== a;
    h.b <== b;
    out <== h.out;
}

/// Public: root, nullifierHash, recipient, fee.
/// Private: nullifier, secret, pathElements[8], pathIndices[8].
template Withdraw(levels) {
    signal input root;
    signal input nullifierHash;
    signal input recipient;
    signal input fee;
    signal input nullifier;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // 1. commitment = Hash2(nullifier, secret)
    component comm = Hash2();
    comm.a <== nullifier;
    comm.b <== secret;

    // 2. Merkle membership of commitment under root
    component step[levels];
    signal cur[levels + 1];
    cur[0] <== comm.out;

    for (var i = 0; i < levels; i++) {
        step[i] = HashLeftRight();
        step[i].left <== cur[i];
        step[i].right <== pathElements[i];
        step[i].sel <== pathIndices[i];
        cur[i + 1] <== step[i].out;
    }

    cur[levels] === root;

    // 3. nullifierHash === Hash2(nullifier, 1)
    component nh = Hash2();
    nh.a <== nullifier;
    nh.b <== 1;
    nh.out === nullifierHash;

    // 4. bind recipient and fee
    signal r2 <== recipient * recipient;
    signal f2 <== fee * fee;
    signal dummy;
    dummy <== r2 + f2;
}

component main {public [root, nullifierHash, recipient, fee]} = Withdraw(8);
