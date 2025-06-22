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
  aws_secretsmanager as secretsmanager,  // Secrets Manager用に追加
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

    // 自動Dockerイメージデプロイメント（GitHub Actions使用時はコメントアウト推奨）
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
      maxAzs: 1,
    });

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
    // SSL証明書（ACM）
    //**************************************************** */
    const certificate = new acm.Certificate(this, 'SslCertificate', {
      domainName: domainName,
      validation: acm.CertificateValidation.fromDns(),
    });

    //**************************************************** */
    // ALB（Application Load Balancer）
    //**************************************************** */
    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc,
      allowAllOutbound: true,
    });

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443), // HTTPS
      "Allow HTTPS traffic from Cloudflare"
    );

    const alb = new elbv2.ApplicationLoadBalancer(this, 'alb', {
      internetFacing: true,
      loadBalancerName: 'nextjs-alb',
      securityGroup: albSecurityGroup,
      vpc
    });

    // 3. HTTPS リスナー追加
    const httpsListener = alb.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
    });

    // 4. HTTP → HTTPS リダイレクト
    alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
      }),
    });

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
    // Secrets Manager 参照の定義
    //**************************************************** */
    // 全ての環境変数をSecrets Managerから取得
    const appSecrets = secretsmanager.Secret.fromSecretNameV2(this, 'AppSecrets', 'nextjs-app/env');

    //**************************************************** */
    // EC2 Task Definition & Service
    //**************************************************** */
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
      ]
    });

    // Secrets Manager読み取り権限を追加
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:DescribeSecret'
      ],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:nextjs-app/env*`
      ]
    }));

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
      // 公開可能な環境変数（平文で保存される）
      environment: {
        'NODE_ENV': 'production',           // Node.js実行環境
        'PORT': '3000',                     // アプリケーションポート
        'HOSTNAME': '0.0.0.0',             // バインドするホスト名
        'NEXT_TELEMETRY_DISABLED': '1',    // Next.jsテレメトリ無効化
      },
      // 全ての環境変数をSecrets Managerから取得
      secrets: {
        'AUTH_SECRET': ecs.Secret.fromSecretsManager(appSecrets, 'AUTH_SECRET'),
        'NEXTAUTH_URL': ecs.Secret.fromSecretsManager(appSecrets, 'NEXTAUTH_URL'),
        'AUTH_GOOGLE_ID': ecs.Secret.fromSecretsManager(appSecrets, 'AUTH_GOOGLE_ID'),
        'AUTH_GOOGLE_SECRET': ecs.Secret.fromSecretsManager(appSecrets, 'AUTH_GOOGLE_SECRET'),
        'DATABASE_URL': ecs.Secret.fromSecretsManager(appSecrets, 'DATABASE_URL'),
        'AUTH_TRUST_HOST': ecs.Secret.fromSecretsManager(appSecrets, 'AUTH_TRUST_HOST'),
      },
      // ヘルスチェック設定（テスト用に無効化）
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

    httpsListener.addTargets('EcsTargetGroup', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: "/",
        interval: Duration.seconds(120),
        timeout: Duration.seconds(60),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 10,
        port: "traffic-port",
        protocol: elbv2.Protocol.HTTP,
      },
      deregistrationDelay: Duration.seconds(300),
    });

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
  }
}