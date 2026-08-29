import { IperfCommands } from "./types";

export const defaultIperfCommands: IperfCommands = {
  tcpDownload: "iperf3 -c {server} {port} -t {duration} -R -J",
  tcpUpload: "iperf3 -c {server} {port} -t {duration} -J",
  udpDownload: "iperf3 -c {server} {port} -t 5 -R -u -b 100M -J",
  udpUpload: "iperf3 -c {server} {port} -t 5 -u -b 100M -J",
};

export function buildIperfCommand(
  template: string,
  server: string,
  port: string,
  duration: number,
): string {
  return template
    .replace("{server}", server)
    .replace("{port}", port ? `-p ${port}` : "")
    .replace("{duration}", String(duration))
    .replace(/\s+/g, " ")
    .trim();
}
