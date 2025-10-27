import { EventBridgeEvent } from 'aws-lambda';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';

const s3Client = new S3Client();
const BUCKET_NAME = process.env.BUCKET_NAME!;
const THUMBNAIL_PREFIX = process.env.THUMBNAIL_PREFIX || 'thumbnails/';
const FFMPEG_PATH = '/opt/nodejs/node_modules/ffmpeg-static/ffmpeg';
const execAsync = promisify(exec);

interface S3ObjectCreatedDetail {
  bucket: { name: string };
  object: { key: string };
}

export const handler = async (
  event: EventBridgeEvent<'Object Created', S3ObjectCreatedDetail>
): Promise<void> => {
  const detail = event.detail;
  const key = decodeURIComponent(detail.object.key.replace(/\+/g, ' '));
  const bucketName = detail.bucket.name;

  // Avoid recursion
  if (key.startsWith(THUMBNAIL_PREFIX)) {
    console.log(`Skipping thumbnail: ${key}`);
    return;
  }

  try {
    //  Retrieve the Content-Type
    const headResponse = await s3Client.send(
      new HeadObjectCommand({ Bucket: bucketName, Key: key })
    );
    const contentType = headResponse.ContentType || '';

    const isImage = contentType.startsWith('image/');
    const isVideo = contentType.startsWith('video/');

    if (!isImage && !isVideo) {
      console.log(`Skipping non-media: ${key}`);
      return;
    }

    // Download the file
    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: key })
    );
    const buffer = await streamToBuffer(response.Body!);

    let thumbnailBuffer: Buffer;

    if (isImage) {
      thumbnailBuffer = await sharp(buffer)
        .resize(300, 300, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toBuffer();
    } else if (isVideo) {
      const inputPath = `/tmp/${key.replace(/\//g, '_')}`;
      const outputPath = `/tmp/thumb_${Date.now()}.jpg`;

      await fs.writeFile(inputPath, buffer);
      await execAsync(
        `${FFMPEG_PATH} -i "${inputPath}" -ss 00:00:01 -vframes 1 -s 300x300 "${outputPath}"`
      );
      thumbnailBuffer = await fs.readFile(outputPath);

      // Nettoyage
      await fs.unlink(inputPath);
      await fs.unlink(outputPath);
    } else {
      return;
    }

    //  Save thumbnail
    const thumbnailKey = `${THUMBNAIL_PREFIX}${key}.jpg`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: thumbnailKey,
        Body: thumbnailBuffer,
        ContentType: 'image/jpeg',
      })
    );

    console.log(`Thumbnail created: ${thumbnailKey}`);
  } catch (error) {
    console.error(`Failed to process ${key}:`, error);
  }
};

function streamToBuffer(stream: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}