import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as path from 'path';
import { Construct } from 'constructs';

export class FileStorageStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 🔒 S3 Bucket privé
    const fileBucket = new s3.Bucket(this, 'FileStorageBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      //
      enforceSSL: true,
      lifecycleRules: [
        {
          // Supprime les objets non confirmés après 7 jours
          expiration: cdk.Duration.days(7),
          prefix: '', // s'applique à tout le bucket
        },
      ],
      cors: [
    {
      allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
      allowedOrigins: ['http://localhost:5173','http://localhost:5174'], // 👈 Votre frontend en dev
      allowedHeaders: ['*'],
    },
  ],
    });

    // 🗃️ DynamoDB Table
    const fileTable = new dynamodb.Table(this, 'FileMetadataTable', {
      partitionKey: { name: 'fileId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // ⚠️ Dev only
    });

    // ⚙️ Lambda 1: Upload & API Handler
    const uploadHandler = new lambda.Function(this, 'UploadHandlerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/upload-handler'), {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: ['bash', '-c', 'npm ci  --cache /tmp/empty-cache && npm run build && cp -r . /asset-output'],
        },
      }),
      environment: {
        BUCKET_NAME: fileBucket.bucketName,
        TABLE_NAME: fileTable.tableName,
      },
      timeout: cdk.Duration.seconds(10),
    });

    // ⚙️ Lambda 2: Metadata Updater (événement S3)
    const metadataUpdater = new lambda.Function(this, 'MetadataUpdaterFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/metadata-updater'), {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: ['bash', '-c', 'npm ci  --cache /tmp/empty-cache && npm run build && cp -r . /asset-output'],
        },
      }),
      environment: {
        TABLE_NAME: fileTable.tableName,
      },
      timeout: cdk.Duration.seconds(10),
    });

    // 🔐 Permissions
    fileBucket.grantReadWrite(uploadHandler);
    fileTable.grantReadWriteData(uploadHandler);

    fileBucket.grantRead(metadataUpdater); // Pour lire les métadonnées S3
    fileTable.grantWriteData(metadataUpdater);

    // 🔔 Déclencheur S3 → Metadata Updater
    fileBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(metadataUpdater)
    );

    // 🌐 API Gateway (mode proxy partout)
    const api = new apigw.RestApi(this, 'FileStorageApi', {
      restApiName: 'File Storage Service',
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
      },
    });

    // Routes
    const uploadUrlResource = api.root.addResource('upload-url');
    uploadUrlResource.addMethod('GET', new apigw.LambdaIntegration(uploadHandler));

    const filesResource = api.root.addResource('files');
    filesResource.addMethod('GET', new apigw.LambdaIntegration(uploadHandler));

    const fileResource = filesResource.addResource('{fileId}');
    fileResource.addMethod('GET', new apigw.LambdaIntegration(uploadHandler)); // /files/{id}/download
    fileResource.addMethod('DELETE', new apigw.LambdaIntegration(uploadHandler));
  }
}