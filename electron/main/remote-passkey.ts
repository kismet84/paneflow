import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import type { RemoteMobileDevice, RemotePasskeyCredential } from "./remote-credential-store.js";

const relyingParty = (relayUrl: string): { origin: string; rpID: string } => {
  const url = new URL(relayUrl);
  return { origin: url.origin, rpID: url.hostname };
};

export class RemotePasskeyService {
  async registrationOptions(deviceId: string, devices: RemoteMobileDevice[]) {
    const active = devices.filter((device) => device.revokedAt === null && device.passkey);
    return generateRegistrationOptions({
      rpName: "Codex Pane",
      rpID: this.#rpID,
      userName: "Codex Pane mobile",
      userID: new TextEncoder().encode(deviceId),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: active.map((device) => ({ id: device.passkey!.id, transports: device.passkey!.transports as AuthenticatorTransportFuture[] }))
    });
  }

  async verifyRegistration(challenge: string, response: RegistrationResponseJSON, name: string): Promise<RemotePasskeyCredential> {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.#origin,
      expectedRPID: this.#rpID,
      requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo) throw new Error("Passkey 登记未完成，请重试。");
    const credential = verification.registrationInfo.credential;
    return {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports ?? [],
      name: name.slice(0, 200) || "手机 Passkey",
      createdAt: Date.now(),
      lastUsedAt: null
    };
  }

  async authenticationOptions(device: RemoteMobileDevice) {
    if (!device.passkey || device.authentication === "native") throw new Error("此设备不是 Passkey 设备。");
    return generateAuthenticationOptions({
      rpID: this.#rpID,
      userVerification: "required",
      allowCredentials: [{ id: device.passkey.id, transports: device.passkey.transports as AuthenticatorTransportFuture[] }]
    });
  }

  async verifyAuthentication(challenge: string, response: AuthenticationResponseJSON, device: RemoteMobileDevice): Promise<number> {
    if (!device.passkey || device.authentication === "native") throw new Error("此设备不是 Passkey 设备。");
    if (response.id !== device.passkey.id) throw new Error("该 Passkey 不属于当前设备。");
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.#origin,
      expectedRPID: this.#rpID,
      requireUserVerification: true,
      credential: {
        id: device.passkey.id,
        publicKey: new Uint8Array(Buffer.from(device.passkey.publicKey, "base64url")),
        counter: device.passkey.counter,
        transports: device.passkey.transports as AuthenticatorTransportFuture[]
      }
    });
    if (!verification.verified) throw new Error("Passkey 验证失败。");
    return verification.authenticationInfo.newCounter;
  }

  readonly #origin: string;
  readonly #rpID: string;

  constructor(relayUrl: string) {
    const rp = relyingParty(relayUrl);
    this.#origin = rp.origin;
    this.#rpID = rp.rpID;
  }
}
