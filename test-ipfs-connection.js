const { create } = require('kubo-rpc-client');

async function testIPFSConnection() {
  console.log('Testing IPFS connection...');
  
  const ipfs = create({ 
    url: 'http://127.0.0.1:5001',
    timeout: 10000 // 10 second timeout
  });

  try {
    console.log('Attempting to get IPFS version...');
    const version = await ipfs.version();
    console.log('✅ IPFS connection successful!');
    console.log('IPFS version:', version.version);
    console.log('IPFS commit:', version.commit);
    
    // Test adding a small piece of data
    console.log('\nTesting file upload...');
    const testData = Buffer.from('Hello, IPFS!');
    const result = await ipfs.add(testData, {
      cidVersion: 1,
      hashAlg: 'sha2-256'
    });
    console.log('✅ Test upload successful!');
    console.log('Test CID:', result.cid.toString());
    
  } catch (error) {
    console.error('❌ IPFS connection failed:');
    console.error('Error:', error.message);
    console.error('Code:', error.code);
    
    if (error.code === 'ECONNREFUSED') {
      console.error('\n🔧 Troubleshooting:');
      console.error('1. Make sure IPFS daemon is running: ipfs daemon');
      console.error('2. Check if IPFS API is accessible: curl http://127.0.0.1:5001/api/v0/version');
      console.error('3. Verify IPFS configuration allows API access');
    }
  }
}

testIPFSConnection();
