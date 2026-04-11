import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters';
import { LoggingInterceptor } from './common/interceptors';

/**
 * Narrow safety net for the smartapi-javascript WebSocket heartbeat bug:
 * its internal setTimeout calls `ws.send()` without checking readyState,
 * and when the socket is still in CONNECTING the throw escapes unhandled
 * and kills the whole process. Swallow only THAT specific error; rethrow
 * everything else so real bugs still crash loudly.
 */
process.on('uncaughtException', (err: Error) => {
  const msg = err?.message ?? '';
  const stack = err?.stack ?? '';
  if (
    msg.includes('WebSocket is not open: readyState 0') &&
    stack.includes('smartapi-javascript')
  ) {
    // eslint-disable-next-line no-console
    console.warn('[uncaughtException] smartapi WS heartbeat on CONNECTING socket — swallowed:', msg);
    return;
  }
  // Unknown error — preserve default behaviour.
  // eslint-disable-next-line no-console
  console.error('[uncaughtException]', err);
  throw err;
});

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3001);

  // CORS
  app.enableCors({
    origin: 'http://localhost:3000',
    credentials: true,
  });

  // WebSocket adapter (Socket.IO)
  app.useWebSocketAdapter(new IoAdapter(app));

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global logging interceptor
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Swagger API docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('TD Automation API')
    .setDescription('Trading automation platform API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(port);
  logger.log(`TD Automation API running on http://localhost:${port}`);
  logger.log(`Swagger docs available at http://localhost:${port}/api/docs`);
}

bootstrap();
