package org.openbooks.openbooksapi;

import org.openbooks.openbooksapi.core.model.ChartOfAccounts;
import org.openbooks.openbooksapi.core.model.ChartOfAccountsFactory;
import org.openbooks.openbooksapi.core.model.Journal;
import org.openbooks.openbooksapi.core.model.JournalFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class OpenBooksApplication {

	public static void main(String[] args) {

	    SpringApplication.run(OpenBooksApplication.class, args);
	}

    @Bean
    public ChartOfAccounts chartOfAccounts(ChartOfAccountsFactory factory) {

        return factory.build();
    }

    @Bean
    public Journal journal(JournalFactory factory) {

        return factory.build();
    }

}
