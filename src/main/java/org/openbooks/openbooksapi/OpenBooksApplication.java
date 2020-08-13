package org.openbooks.openbooksapi;

import org.openbooks.openbooksapi.core.model.ChartOfAccountsService;
import org.openbooks.openbooksapi.core.model.ChartOfAccountsServiceFactory;
import org.openbooks.openbooksapi.core.model.JournalService;
import org.openbooks.openbooksapi.core.model.JournalServiceFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class OpenBooksApplication {

	public static void main(String[] args) {

	    SpringApplication.run(OpenBooksApplication.class, args);
	}

	@Bean
    public ChartOfAccountsService chartOfAccounts(ChartOfAccountsServiceFactory factory) {

        return factory.build();
    }

    @Bean
    public JournalService journal(JournalServiceFactory factory) {

        return factory.build();
    }

}
