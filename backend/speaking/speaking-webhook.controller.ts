// modules
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
// decorators
import { Public } from 'common/decorators/public_decorator';
// services
import { SpeakingWebhookService } from './services/speaking-webhook.service';

@ApiTags('Speaking')
@Controller('speaking/webhook')
export class SpeakingWebhookController {
  constructor(private readonly webhook: SpeakingWebhookService) {}

  /**
   * CALL-E terminal events. The token in the path is the only authentication
   * CALL-E offers (no signature); the body is deliberately untyped so a new
   * upstream field never turns into a 400 that makes CALL-E retry forever.
   */
  @Public()
  @Post(':token')
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiExcludeEndpoint()
  async receive(
    @Param('token') token: string,
    @Body() body: unknown,
    @Headers('call-e-event-id') eventIdHeader: string | undefined,
    @Req() req: Request,
  ): Promise<{ ok: true; outcome: string }> {
    if (!this.webhook.isValidToken(token, req.ip)) {
      throw new UnauthorizedException('Invalid webhook token');
    }
    return this.webhook.handleBody(body, eventIdHeader ?? null, req.ip ?? null);
  }
}
