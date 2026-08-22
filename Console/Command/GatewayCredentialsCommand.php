<?php
declare(strict_types=1);

namespace Afd\AI\Console\Command;

use Afd\AI\Model\Gateway\GatewaySecretManager;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

/** Displays the active Magento-generated credentials needed by Node replicas. */
class GatewayCredentialsCommand extends Command
{
    public function __construct(private readonly GatewaySecretManager $gatewaySecretManager)
    {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this->setName('afd:ai:gateway:credentials')
            ->setDescription('Print the active Afd AI gateway credentials for Node environment configuration.');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $credentials = $this->gatewaySecretManager->getCredentials();

        $output->writeln('<comment>Set these values on every Node gateway replica, then restart the Node service.</comment>');
        $output->writeln('AI_NODE_SYNC_SECRET=' . $credentials['node_sync_secret']);
        $output->writeln('AI_WS_TICKET_SECRET=' . $credentials['ws_ticket_secret']);

        return Command::SUCCESS;
    }
}
