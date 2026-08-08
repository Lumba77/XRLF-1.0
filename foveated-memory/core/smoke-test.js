const { validateHook } = require('./hook-validator');

function runSmokeTest() {
    console.log('Running Hook Validator Smoke Test...');

    const validHook = { id: '1', type: 'recall', action: 'fetch' };
    const invalidHook = { id: '2', type: 'recall' }; // Missing action

    const isValValid = validateHook(validHook);
    const isInvValid = validateHook(invalidHook);

    console.log(`Valid Hook Test: ${isValValid ? 'PASSED' : 'FAILED'}`);
    console.log(`Invalid Hook Test: ${!isInvValid ? 'PASSED' : 'FAILED'}`);

    if (isValValid && !isInvValid) {
        console.log('✅ Smoke Test Passed Successfully');
        process.exit(0);
    } else {
        console.error('❌ Smoke Test Failed');
        process.exit(1);
    }
}

runSmokeTest();
