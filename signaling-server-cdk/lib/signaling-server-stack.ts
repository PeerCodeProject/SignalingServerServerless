import {
  CfnOutput, RemovalPolicy, Stack, StackProps,
  aws_lambda_nodejs,
  aws_dynamodb,
  aws_logs,
  aws_lambda,
  aws_apigatewayv2,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export class SignalingServerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const YWebRtcTopicsTable = new aws_dynamodb.Table(this, "YWebRtcTopicsTable", {
      tableName: "YWebRtcTopicsTable",
      partitionKey: {
        name: "name",
        type: aws_dynamodb.AttributeType.STRING,
      },
      billingMode: aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const envVariables = {
      AWS_ACCOUNT_ID: Stack.of(this).account,
    };

    const esBuildSettings = {
      minify: true
    }

    const functionSettings = {
      handler: "handler",
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      memorySize: 256,
      environment: {
        TABLE_NAME: YWebRtcTopicsTable.tableName,
        ...envVariables
      },
      logRetention: aws_logs.RetentionDays.ONE_WEEK,
      tracing: aws_lambda.Tracing.ACTIVE,
      bundling: esBuildSettings
    }

    const handler = new aws_lambda_nodejs.NodejsFunction(this, "YWebRtcSignalingLambdaFunction",
      {
        awsSdkConnectionReuse: true,
        entry: "./src/app.ts",
        ...functionSettings
      });

      
    YWebRtcTopicsTable.grantReadData(handler);
    YWebRtcTopicsTable.grantWriteData(handler);


    const webSocketApi = new aws_apigatewayv2.CfnApi(this, 'YWebRtcApi', {
      name: "ywebrtc-api",
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.type"
    });

    const rtcIntegration = new aws_apigatewayv2.CfnIntegration(this, "YWebRtcIntegration", {
      apiId: webSocketApi.ref,
      description: "y-webrtc signaling integration",
      integrationType: "AWS_PROXY",
      integrationUri: handler.functionArn // !Sub arn:${AWS::Partition}:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${YWebRtcSignalingLambdaFunction.Arn}/invocations
    });

    const connectRoute = new aws_apigatewayv2.CfnRoute(this, "YWebRtcConnectRoute", {
      apiId: webSocketApi.ref,
      routeKey: "$connect",
      authorizationType: "NONE",
      operationName: "ConnectRoute",
      target: rtcIntegration.ref
    });


    const disconnectRoute = new aws_apigatewayv2.CfnRoute(this, "YWebRtcDisconnectRoute", {
      apiId: webSocketApi.ref,
      routeKey: "$disconnect",
      authorizationType: "NONE",
      operationName: "DisconnectRoute",
      target: rtcIntegration.ref
    })

    const defaultRoute = new aws_apigatewayv2.CfnRoute(this, "YWebRtcDefaultRoute", {
      apiId: webSocketApi.ref,
      routeKey: "$default",
      authorizationType: "NONE",
      operationName: "DefaultRoute",
      target: rtcIntegration.ref
    })

    const deployement = new aws_apigatewayv2.CfnDeployment(this, "YWebRtcDeployment", {
      apiId: webSocketApi.ref

    })

    deployement.addDependsOn(connectRoute);
    deployement.addDependsOn(disconnectRoute);
    deployement.addDependsOn(defaultRoute);



    const apiStage = new aws_apigatewayv2.CfnStage(this, "YWebRtcApiStage", {
      apiId: webSocketApi.ref,
      stageName: "dev",
      deploymentId: deployement.ref
    });

    const invokePermission = new aws_lambda.CfnPermission(this, "YWebRtcInvokePermission", {
      action: "lambda:InvokeFunction",
      functionName: handler.functionName,
      principal: "apigateway.amazonaws.com",
    });

    const domain = "peercode.com";

    // const certificate = new aws_certificatemanager.Certificate(this, "YWebRtcApiCertificate", {
    //   domainName: `webrtc.${domain}`,
    //   validation: {
    //     apiDomainName: `webrtc.${domain}`,
    //     hostedZoneId: "!Ref HostedZoneId" // FIX,
    //   },
    // }
    // );

    // const apiDomainName = new aws_apigatewayv2.CfnDomainName(this, "YWebRtcApiDomainName", {
    //   domainName: "ywebrtc-api-dev.example.com",
    //   domainNameConfigurations: [{
    //     certificateArn: certificate.ref,
    //      securityPolicy: "TLS_1_2"
    //   }]});

  // YWebRtcApiMapping:
  //   Type: AWS::ApiGatewayV2::ApiMapping
  //   Properties:
  //     ApiId: !Ref YWebRtcApi
  //     DomainName: !Sub 'webrtc.${Domain}'
  //     Stage: !Ref YWebRtcApiStage
  //   DependsOn:
  //     - YWebRtcApiDomainName

  // YWebRtcApiRecordSet:
  //   Type: AWS::Route53::RecordSet
  //   Properties:
  //     AliasTarget:
  //       DNSName: !GetAtt YWebRtcApiDomainName.RegionalDomainName
  //       HostedZoneId: !GetAtt YWebRtcApiDomainName.RegionalHostedZoneId
  //     # See https://forums.aws.amazon.com/thread.jspa?threadID=103919: The `HostedZoneName` requires the trailing dot.
  //     HostedZoneName: !Sub '${Domain}.'
  //     Name: !Sub 'webrtc.${Domain}'
  //   Type: A 
    
    new CfnOutput(this, "ApiURL", {
      value: `${webSocketApi.ref}`,
    });
  }
}
