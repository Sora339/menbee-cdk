import {
  Stack,
  StackProps,
  RemovalPolicy,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_logs as logs,
  aws_iam as iam,
  aws_elasticloadbalancingv2 as elbv2,
  aws_autoscaling as autoscaling,
  aws_certificatemanager as acm,
  aws_route53 as route53,
  aws_route53_targets as targets,  // 追加
  Duration,
  CfnOutput,
} from 'aws-cdk-lib';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import * as imagedeploy from 'cdk-docker-image-deployment';
import { Construct } from 'constructs';
import * as path from 'path';

export interface DockerImageDeploymentStackProps extends StackProps {
  domainName: string;        // ドメイン名を追加
}

export class DockerImageDeploymentStack extends Stack {
  constructor(scope: Construct, id: string, props: DockerImageDeploymentStackProps) {
    super(scope, id, props);

    const { domainName } = props;

    //**************************************************** */
    // ECR
    //**************************************************** */
    const repository = new Repository(this, 'NextjsEcrRepo', {
      repositoryName: 'nextjs-app',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // 自動Dockerイメージデプロイメント
    new imagedeploy.DockerImageDeployment(this, "DeployDockerImage", {
      source: imagedeploy.Source.directory(
        path.join(__dirname, '../../Menbee') // CDKからみてMenbeeディレクトリを指定
      ),
      destination: imagedeploy.Destination.ecr(repository, {
        tag: 'latest',
      }),
    });

    //**************************************************** */
    // VPC
    //**************************************************** */
    const vpc = new ec2.Vpc(this, 'NextjsVpc', {
      maxAzs: 2,
    });

    //**************************************************** */
    // Cloudflare使用のため、Route 53とSSL証明書をコメントアウト
    //**************************************************** */
    /*
    const hostedZone = new route53.HostedZone(this, 'HostedZone', {
      zoneName: domainName,
    });

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: domainName,
      subjectAlternativeNames: [`www.${domainName}`],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });
    */

    //**************************************************** */
    // ECS Cluster
    //**************************************************** */
    const cluster = new ecs.Cluster(this, 'NextjsCluster', {
      vpc,
      clusterName: 'nextjs-cluster',
    });

    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: '/aws/ecs/nextjs-cluster',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    //**************************************************** */
    // EC2用のセキュリティグループ
    //**************************************************** */
    const ec2SecurityGroup = new ec2.SecurityGroup(this, "Ec2SecurityGroup", {
      vpc,
      allowAllOutbound: true,
    });

    ec2SecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "Allow SSH access"
    );

    //**************************************************** */
    // EC2 Auto Scaling Group
    //**************************************************** */
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      // EC2コンソールアクセス用のパスワード設定
      'echo "ec2-user:your-password-here" | chpasswd',
      'sed -i "s/PasswordAuthentication no/PasswordAuthentication yes/g" /etc/ssh/sshd_config',
      'systemctl restart sshd',
      // ECSエージェント設定
      'echo ECS_CLUSTER=nextjs-cluster >> /etc/ecs/ecs.config',
    );

    const autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'ASG', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
      userData: userData,
      minCapacity: 1,
      maxCapacity: 1,
      desiredCapacity: 1,
      securityGroup: ec2SecurityGroup,
    });

    // ECSクラスターにEC2インスタンスを追加
    const capacityProvider = new ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
      autoScalingGroup,
    });
    cluster.addAsgCapacityProvider(capacityProvider);

    //**************************************************** */
    // SSL証明書（ACM）をコメントアウト - Cloudflareが処理
    //**************************************************** */
    /*
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: domainName,
      subjectAlternativeNames: [`www.${domainName}`],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });
    */

    //**************************************************** */
    // ALB（Application Load Balancer）
    //**************************************************** */
    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc,
      allowAllOutbound: true,
    });

    // HTTP (80) のみ許可 - CloudflareがHTTPS終端
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP traffic from Cloudflare"
    );

    const alb = new elbv2.ApplicationLoadBalancer(this, 'alb', {
      internetFacing: true,
      loadBalancerName: 'nextjs-alb',
      securityGroup: albSecurityGroup,
      vpc
    });

    // HTTPリスナーのみ（CloudflareがHTTPS処理）
    const httpListener = alb.addListener('HttpListener', {
      port: 80,
      open: true,
    });

    /*
    // HTTPSリスナーをコメントアウト
    const httpsListener = alb.addListener('HttpsListener', {
      port: 443,
      certificates: [certificate],
      open: true,
    });

    // HTTPからHTTPSへのリダイレクトも不要
    alb.addListener('HttpListener', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });
    */

    //**************************************************** */
    // サービス用セキュリティグループ
    //**************************************************** */
    const serviceSecurityGroup = new ec2.SecurityGroup(this, "ServiceSecurityGroup", {
      vpc,
      allowAllOutbound: true,
    });

    serviceSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(3000),
      "Allow traffic from ALB"
    );

    // EC2セキュリティグループにALBからのアクセスを許可
    ec2SecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(3000),
      "Allow traffic from ALB to container port 3000"
    );

    // 動的ポートマッピング用の範囲も開放
    ec2SecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcpRange(32768, 65535),
      "Allow traffic from ALB to dynamic ports"
    );

    //**************************************************** */
    // EC2 Task Definition & Service
    //**************************************************** */
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
      ]
    });

    // ECS Exec用のSSM権限を追加
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel'
      ],
      resources: ['*']
    }));

    const taskDefinition = new ecs.Ec2TaskDefinition(this, "TaskDef", {
      family: 'nextjs-task-family',
      networkMode: ecs.NetworkMode.BRIDGE,
      taskRole: taskRole, // 作成したロールを使用
    });

    taskDefinition.addContainer("NextjsContainer", {
      containerName: 'nextjs-container',
      image: ecs.ContainerImage.fromEcrRepository(repository, "latest"),
      memoryReservationMiB: 200,
      memoryLimitMiB: 800,
      cpu: 128,
      portMappings: [{
        containerPort: 3000,
        hostPort: 0, // 動的ポートマッピング
        protocol: ecs.Protocol.TCP
      }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `container`,
        logGroup,
      }),
      essential: true,
      startTimeout: Duration.minutes(10),
      stopTimeout: Duration.minutes(2),
      environment: {
        'NODE_ENV': 'production',
        'PORT': '3000',
        'HOSTNAME': '0.0.0.0',
        'NEXT_TELEMETRY_DISABLED': '1',
      },
      // ヘルスチェックを無効化（テスト用）
      healthCheck: {
        command: ['CMD-SHELL', 'exit 0'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(60)
      }
    });

    const service = new ecs.Ec2Service(this, "Ec2Service", {
      cluster,
      serviceName: 'nextjs-service',
      taskDefinition: taskDefinition,
      desiredCount: 1, // 小さいインスタンスなので1つのタスクのみ
      enableExecuteCommand: true, // ECS Execを有効化
      placementStrategies: [
        ecs.PlacementStrategy.spreadAcrossInstances(),
      ],
    });

    // HTTPリスナーにターゲットグループを追加
    httpListener.addTargets('EcsTargetGroup', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: "/",
        interval: Duration.seconds(120), // 間隔を大幅に延長
        timeout: Duration.seconds(60), // タイムアウトを延長
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 10, // 失敗許容回数を大幅に増加
        port: "traffic-port",
        protocol: elbv2.Protocol.HTTP,
      },
      deregistrationDelay: Duration.seconds(300), // 登録解除の遅延を延長
    });

    //**************************************************** */
    // Route 53 レコード（Cloudflare使用のためコメントアウト）
    //**************************************************** */
    /*
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new targets.LoadBalancerTarget(alb)
      ),
    });

    new route53.ARecord(this, 'WwwAliasRecord', {
      zone: hostedZone,
      recordName: 'www',
      target: route53.RecordTarget.fromAlias(
        new targets.LoadBalancerTarget(alb)
      ),
    });
    */

    //**************************************************** */
    // 出力
    //**************************************************** */
    new CfnOutput(this, 'LoadBalancerDNS', {
      value: alb.loadBalancerDnsName,
      description: 'ALB DNS name - Connected to Cloudflare',
    });

    new CfnOutput(this, 'DomainName', {
      value: `https://${domainName}`,
      description: 'HTTPS URL (handled by Cloudflare)',
    });

    /*
    // SSL証明書情報（Cloudflare使用のためコメントアウト）
    new CfnOutput(this, 'CertificateArn', {
      value: certificate.certificateArn,
      description: 'SSL Certificate ARN',
    });
    */
  }
}