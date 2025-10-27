import { S3Event } from "aws-lambda";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const dynamoClient = new DynamoDBClient();
const TABLE_NAME = process.env.TABLE_NAME!;

// Type for the extended S3 object (only what we use)
interface ExtendedS3Object {
  key: string;
  size: number;
  contentType?: string;
  eTag: string;
  sequencer: string;
  versionId?: string;
}

// Utility function to extract contentType
function getContentTypeFromRecord(record: any): string {
  //AWS sends contentType in S3 event if Content-Type was specified on upload
  const contentType = record?.s3?.object?.contentType;
  return typeof contentType === "string" && contentType.trim() !== ""
    ? contentType.trim()
    : "application/octet-stream";
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
            "SET #status = :status, fileSize = :size, uploadedAt = :uploadedAt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": { S: "completed" },
            ":size": { N: size.toString() },
            ":uploadedAt": { S: new Date().toISOString() },
          },
          ConditionExpression: "attribute_exists(fileId)",
        })
      );

      console.log(`✅ Updated metadata for file: ${objectKey}`);
    } catch (error) {
      console.error(`❌ Error processing S3 event record:`, error);
    }
  }
};
