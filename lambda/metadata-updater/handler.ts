// lambda/metadata-updater/handler.ts
import { S3Event } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const dynamoClient = new DynamoDBClient();
const TABLE_NAME = process.env.TABLE_NAME!;

// Type pour l'objet S3 étendu (seulement ce qu'on utilise)
interface ExtendedS3Object {
  key: string;
  size: number;
  contentType?: string;
  eTag: string;
  sequencer: string;
  versionId?: string;
}

// Fonction utilitaire pour extraire contentType de façon sûre
function getContentTypeFromRecord(record: any): string {
  // AWS envoie contentType dans l'événement S3 si Content-Type a été spécifié à l'upload
  const contentType = record?.s3?.object?.contentType;
  return typeof contentType === 'string' && contentType.trim() !== ''
    ? contentType.trim()
    : 'application/octet-stream';
}

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    try {
      const bucketName = record.s3.bucket.name;
      const objectKey = record.s3.object.key;
      const size = record.s3.object.size;

      const contentType = getContentTypeFromRecord(record);

      await dynamoClient.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: { fileId: { S: objectKey } },
          UpdateExpression:
            'SET #status = :status, fileSize = :size, contentType = :contentType, uploadedAt = :uploadedAt',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':status': { S: 'completed' },
            ':size': { N: size.toString() },
            ':contentType': { S: contentType },
            ':uploadedAt': { S: new Date().toISOString() },
          },
          ConditionExpression: 'attribute_exists(fileId)',
        })
      );

      console.log(`✅ Updated metadata for file: ${objectKey}`);
    } catch (error) {
      console.error(`❌ Error processing S3 event record:`, error);
      // En production, envisagez une DLQ ou une alarme CloudWatch
    }
  }
};