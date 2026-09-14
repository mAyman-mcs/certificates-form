const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET = process.env.S3_BUCKET;
const isEnabled = Boolean(BUCKET);
const client = isEnabled ? new S3Client({}) : null;

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Returns the object's contents as a Buffer, or null if the key doesn't exist yet. */
async function getObject(key) {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await streamToBuffer(response.Body);
  } catch (err) {
    if (err.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function putObject(key, body, contentType) {
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

module.exports = { getObject, putObject, isEnabled };
